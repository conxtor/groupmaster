package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func newApp(ctx context.Context, cfg config) (*app, error) {
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, err
	}
	nc, err := nats.Connect(cfg.NATSURL, nats.Name("wagi-wa-connector-whatsmeow"), nats.Timeout(15*time.Second), nats.MaxReconnects(-1))
	if err != nil {
		db.Close()
		return nil, err
	}
	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		db.Close()
		return nil, err
	}
	sqlstore.PostgresArrayWrapper = pq.Array
	a := &app{cfg: cfg, db: db, nc: nc, js: js, status: "starting"}
	a.ensureStream()
	log.Printf("whatsapp whatsmeow connector initialized role=%s worker=%s pool_size=%d onboarding_slots=%d", cfg.Role, cfg.WorkerID, cfg.PoolSize, cfg.OnboardingSlots)
	return a, nil
}

func (a *app) close() {
	a.cancelCycle()
	if lease := a.currentLease(); lease != nil {
		_ = lease.release(context.Background(), "shutdown")
		a.setLease(nil)
	}
	if a.nc != nil {
		_ = a.nc.Drain()
		a.nc.Close()
	}
	if a.db != nil {
		a.db.Close()
	}
}

func (a *app) setClient(client *whatsmeow.Client, container *sqlstore.Container) {
	a.mu.Lock()
	a.client = client
	a.store = container
	a.mu.Unlock()
}

func (a *app) runWhatsAppCycle(parent context.Context, onboarding bool) error {
	lease := a.currentLease()
	if lease == nil {
		return errors.New("no connector lease")
	}
	cycleCtx, cancel := context.WithCancel(parent)
	a.setCycleCancel(cancel)
	defer func() {
		cancel()
		a.setCycleCancel(nil)
	}()

	container, err := a.newWhatsmeowStore(cycleCtx)
	if err != nil {
		return fmt.Errorf("open whatsmeow SQL store: %w", err)
	}
	defer container.Close()
	device, err := a.loadDevice(cycleCtx, container, lease, onboarding)
	if err != nil {
		return err
	}
	selected := map[string]bool{}
	initialGroups := []string{}
	recoverySync := false
	if !onboarding {
		groups, selectErr := a.selectedGroups(cycleCtx)
		if selectErr != nil {
			return selectErr
		}
		for _, groupID := range groups {
			selected[groupID] = true
		}
		initialGroups, recoverySync, err = a.syncPlan(cycleCtx, groups)
		if err != nil {
			return err
		}
	}
	configureHistorySync(a.cfg, len(initialGroups) > 0, recoverySync)
	client := whatsmeow.NewClient(device, waLog.Stdout("whatsmeow", "INFO", false))
	client.AutoTrustIdentity = true
	connected := make(chan struct{}, 1)
	client.AddEventHandler(func(evt any) {
		a.handleWhatsAppEvent(cycleCtx, client, selected, evt, connected)
	})
	a.setClient(client, container)
	defer func() {
		client.Disconnect()
		a.setClient(nil, nil)
	}()

	var qr <-chan whatsmeow.QRChannelItem
	if device.ID == nil {
		qr, err = client.GetQRChannel(cycleCtx)
		if err != nil {
			return fmt.Errorf("create WhatsApp QR channel: %w", err)
		}
		_ = lease.updateQR(cycleCtx, "starting", "", nil, nil)
	}
	connectResult := make(chan error, 1)
	go func() { connectResult <- client.ConnectContext(cycleCtx) }()

	connectedSeen := false
	connectReturned := false
	connectErr := error(nil)
	deadline := time.NewTimer(3 * time.Minute)
	defer deadline.Stop()
	for !connectedSeen {
		select {
		case item, ok := <-qr:
			if !ok {
				qr = nil
				continue
			}
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				expires := time.Now().Add(item.Timeout)
				_ = lease.updateQR(cycleCtx, "qr", item.Code, &expires, nil)
			case whatsmeow.QRChannelEventError:
				if item.Error != nil {
					return fmt.Errorf("WhatsApp QR pairing: %w", item.Error)
				}
				return errors.New("WhatsApp QR pairing failed")
			case "success":
				_ = lease.updateQR(cycleCtx, "connected", "", nil, nil)
			case "timeout":
				return errors.New("WHATSAPP_QR_TIMEOUT")
			}
		case <-connected:
			connectedSeen = true
		case result := <-connectResult:
			connectReturned = true
			connectErr = result
			if result != nil {
				return fmt.Errorf("WhatsApp connection: %w", result)
			}
			if client.IsLoggedIn() {
				connectedSeen = true
			}
		case <-deadline.C:
			return errors.New("WhatsApp connection timeout")
		case <-cycleCtx.Done():
			return cycleCtx.Err()
		}
	}
	if !connectReturned {
		select {
		case connectErr = <-connectResult:
			if connectErr != nil && !errors.Is(connectErr, context.Canceled) {
				return fmt.Errorf("WhatsApp connection: %w", connectErr)
			}
		default:
		}
	}
	now := time.Now()
	a.mu.Lock()
	a.connectedAt = &now
	a.mu.Unlock()
	if client.Store.ID != nil {
		if err := lease.markSession(cycleCtx, *client.Store.ID); err != nil {
			return err
		}
	}
	_ = lease.updateQR(cycleCtx, "connected", "", nil, nil)
	a.setStatus(cycleCtx, "ready", "WhatsApp-Session verbunden", nil)

	found, err := a.discoverGroups(cycleCtx, client)
	if err != nil {
		return fmt.Errorf("WhatsApp-Gruppen konnten nicht aktualisiert werden: %w", err)
	}
	if onboarding {
		// Onboarding discovers groups only. Message processing starts later via
		// the normal rotating pool and selected-group access rules.
		_ = found
		if a.cfg.SyncGrace > 0 {
			time.Sleep(minDuration(a.cfg.SyncGrace, 5*time.Second))
		}
		return nil
	}
	selected = map[string]bool{}
	for _, groupID := range mustSelectedGroups(cycleCtx, a) {
		if found[groupID] {
			selected[groupID] = true
		}
	}
	if len(selected) == 0 {
		a.setStatus(cycleCtx, "ready", "WhatsApp verbunden; keine Gruppe ausgewählt", nil)
		return nil
	}
	initialGroups, recoverySync, err = a.syncPlan(cycleCtx, mapKeys(selected))
	if err != nil {
		return err
	}
	selectedGroupIDs := mapKeys(selected)
	for _, groupID := range selectedGroupIDs {
		state, stateErr := lease.loadSyncState(cycleCtx, groupID)
		if stateErr != nil {
			return stateErr
		}
		mode := "incremental"
		if state.InitialBackfillRequired {
			mode = "initial_backfill"
		} else if !state.LastReceivedAt.IsZero() && state.LastReceivedAt.Before(time.Now().UTC().Add(-time.Duration(a.cfg.ReconnectCatchupDays)*24*time.Hour)) {
			mode = "recovery"
		}
		if err := lease.beginSync(cycleCtx, groupID, mode); err != nil {
			return err
		}
	}
	modeDetail := fmt.Sprintf("Inkrementelle Synchronisation für %d ausgewählte Gruppe(n)", len(selected))
	if len(initialGroups) > 0 {
		modeDetail = fmt.Sprintf("Initial-Backfill der letzten %d Tage für %d neue Gruppe(n), danach inkrementelle Synchronisation", a.cfg.BackfillDays, len(initialGroups))
	} else if recoverySync {
		modeDetail = fmt.Sprintf("Recovery-Synchronisation für %d ausgewählte Gruppe(n)", len(selected))
	}
	a.setStatus(cycleCtx, "syncing", modeDetail, nil)
	log.Printf("whatsapp processing selected_groups=%d initial_groups=%d recovery=%t account=%s", len(selected), len(initialGroups), recoverySync, lease.account.ID)
	if len(initialGroups) > 0 {
		if err := a.requestHistory(cycleCtx, client, initialGroups); err != nil {
			return err
		}
	}
	if a.cfg.SyncGrace > 0 {
		time.Sleep(a.cfg.SyncGrace)
	}
	for _, groupID := range selectedGroupIDs {
		state, stateErr := lease.loadSyncState(cycleCtx, groupID)
		if stateErr != nil {
			return stateErr
		}
		mode := "incremental"
		if state.InitialBackfillRequired {
			mode = "initial_backfill"
		} else if !state.LastReceivedAt.IsZero() && state.LastReceivedAt.Before(time.Now().UTC().Add(-time.Duration(a.cfg.ReconnectCatchupDays)*24*time.Hour)) {
			mode = "recovery"
		}
		if err := lease.completeSync(cycleCtx, groupID, mode, syncStats{}); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) loadDevice(ctx context.Context, container *sqlstore.Container, lease *connectorLease, onboarding bool) (*store.Device, error) {
	jid, err := lease.loadJID(ctx)
	if err != nil || jid.IsEmpty() {
		return container.NewDevice(), nil
	}
	device, err := container.GetDevice(ctx, jid)
	if err != nil {
		return nil, fmt.Errorf("load whatsmeow device %s: %w", jid, err)
	}
	if device == nil {
		log.Printf("whatsapp SQL session %s is missing; creating a new pairing device", jid)
		return container.NewDevice(), nil
	}
	if onboarding {
		var status string
		if statusErr := a.db.QueryRow(ctx, "SELECT status FROM connector_accounts WHERE id=$1::uuid", lease.account.ID).Scan(&status); statusErr == nil && status == "reauth_required" {
			if deleteErr := container.DeleteDevice(ctx, device); deleteErr != nil {
				return nil, fmt.Errorf("remove expired whatsmeow device %s: %w", jid, deleteErr)
			}
			return container.NewDevice(), nil
		}
	}
	return device, nil
}

func mustSelectedGroups(ctx context.Context, a *app) []string {
	groups, err := a.selectedGroups(ctx)
	if err != nil {
		log.Printf("whatsapp selected groups refresh failed: %v", err)
		return nil
	}
	return groups
}

func mapKeys(values map[string]bool) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	return result
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func (a *app) runOnboarding(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		request, err := a.claimOnboarding(ctx)
		if err != nil {
			a.setStatus(ctx, "degraded", "WhatsApp-Onboarding wartet auf die Datenbank", err)
			time.Sleep(2 * time.Second)
			continue
		}
		if request == nil {
			time.Sleep(2 * time.Second)
			continue
		}
		lease, err := a.acquire(ctx, "onboarding", request.AccountID)
		if err != nil || lease == nil {
			message := "Kein freier WhatsApp-Onboarding-Slot; QR-Anfrage bleibt in der Warteschlange"
			if err != nil {
				message = err.Error()
			}
			_, _ = a.db.Exec(ctx, "UPDATE connector_onboarding_requests SET status='pending',worker_id=NULL,error=$2,updated_at=NOW() WHERE id=$1::uuid", request.ID, message)
			status, detail := a.waitStatus(ctx)
			a.setStatus(ctx, status, detail, err)
			time.Sleep(2 * time.Second)
			continue
		}
		a.setLease(lease)
		a.mu.Lock()
		a.onboarding = request
		a.mu.Unlock()
		lease.startRenewal(func(renewErr error) {
			a.setStatus(context.Background(), "error", "WhatsApp-Onboarding-Lease verloren", renewErr)
			a.cancelCycle()
		})
		_ = lease.updateOnboarding(ctx, request.ID, "claimed", nil)
		_ = lease.setStatus(ctx, "pairing", nil)
		a.setStatus(ctx, "pairing", "WhatsApp-QR wird für den angemeldeten Nutzer erzeugt", nil)
		err = a.runWhatsAppCycle(ctx, true)
		if err != nil {
			message := err.Error()
			_ = lease.updateQR(ctx, "failed", "", nil, &message)
			_ = lease.updateOnboarding(ctx, request.ID, "failed", &message)
			a.setStatus(ctx, "error", "WhatsApp-QR-Anmeldung fehlgeschlagen", err)
		} else {
			_ = lease.updateQR(ctx, "completed", "", nil, nil)
			_ = lease.updateOnboarding(ctx, request.ID, "completed", nil)
			_ = lease.setStatus(ctx, "paused", nil)
		}
		_ = lease.release(context.Background(), "onboarding_completed")
		a.setLease(nil)
		a.mu.Lock()
		a.onboarding = nil
		a.connectedAt = nil
		a.mu.Unlock()
		if err == nil {
			a.setStatus(ctx, "waiting", "WhatsApp-Onboarding abgeschlossen; Slot freigegeben", nil)
		}
	}
}

func (a *app) runProcessing(ctx context.Context) {
	if a.cfg.StartDelay > 0 {
		time.Sleep(a.cfg.StartDelay)
	}
	for {
		if ctx.Err() != nil {
			return
		}
		lease, err := a.acquire(ctx, "processing", a.cfg.PreferredAccountID)
		if err != nil {
			a.setStatus(ctx, "degraded", "WhatsApp-Processing konnte keine Lease beziehen", err)
			time.Sleep(a.cfg.PoolRetryDelay)
			continue
		}
		if lease == nil {
			status, detail := a.waitStatus(ctx)
			a.setStatus(ctx, status, detail, nil)
			time.Sleep(a.cfg.PoolRetryDelay)
			continue
		}
		a.setLease(lease)
		lease.startRenewal(func(renewErr error) {
			a.setStatus(context.Background(), "error", "WhatsApp-Processing-Lease verloren", renewErr)
			a.cancelCycle()
		})
		_ = lease.setStatus(ctx, "connecting", nil)
		a.setStatus(ctx, "connecting", "WhatsApp-Connector-Slot verbunden", nil)
		err = a.runWhatsAppCycle(ctx, false)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				a.setStatus(ctx, "stopped", "WhatsApp-Connector-Slot wurde freigegeben", nil)
			} else if strings.Contains(err.Error(), "WHATSAPP_REAUTH_REQUIRED") {
				message := err.Error()
				_ = lease.setStatus(ctx, "reauth_required", &message)
				a.setStatus(ctx, "reauth_required", "WhatsApp-Session muss erneut über QR angemeldet werden", err)
			} else {
				a.setStatus(ctx, "error", "WhatsApp-Verarbeitung fehlgeschlagen", err)
			}
		}
		if err != nil && strings.Contains(err.Error(), "WHATSAPP_REAUTH_REQUIRED") {
			_ = lease.release(context.Background(), "reauth_required")
		} else {
			_ = lease.completeAndRelease(context.Background(), time.Now().Add(a.cfg.SyncInterval), "sync_completed")
		}
		a.setLease(nil)
		a.mu.Lock()
		a.connectedAt = nil
		a.mu.Unlock()
	}
}

func (a *app) run(ctx context.Context) {
	a.startSubscriptions(ctx)
	if a.cfg.Role == "onboarding" && a.cfg.PoolEnabled {
		a.runOnboarding(ctx)
		return
	}
	a.runProcessing(ctx)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg := loadConfig()
	a, err := newApp(ctx, cfg)
	if err != nil {
		log.Fatalf("WhatsApp whatsmeow connector startup failed: %v", err)
	}
	defer a.close()
	server := &http.Server{Addr: ":" + cfg.Port, Handler: healthHandler(a), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := server.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("WhatsApp connector HTTP server stopped: %v", serveErr)
		}
	}()
	go a.run(ctx)
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	fmt.Println("WhatsApp whatsmeow connector stopped")
}
