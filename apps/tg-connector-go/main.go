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
	"github.com/nats-io/nats.go"
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
	nc, err := nats.Connect(cfg.NATSURL, nats.Name("wagi-tg-connector-gotd"), nats.Timeout(15*time.Second), nats.MaxReconnects(-1))
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
	a := &app{cfg: cfg, db: db, nc: nc, js: js, status: "starting", entities: map[string]*telegramEntity{}}
	a.ensureStream(ctx)
	log.Printf("telegram gotd connector initialized role=%s worker=%s pool_size=%d onboarding_slots=%d", cfg.Role, cfg.WorkerID, cfg.PoolSize, cfg.OnboardingSlots)
	return a, nil
}

func (a *app) close() {
	a.cancelCycle()
	if lease := a.currentLease(); lease != nil {
		_ = lease.release(context.Background(), "shutdown")
		a.setLease(nil)
	}
	if a.nc != nil {
		a.nc.Drain()
		a.nc.Close()
	}
	if a.db != nil {
		a.db.Close()
	}
}

func (a *app) runOnboarding(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		request, err := a.claimOnboarding(ctx)
		if err != nil {
			a.setStatus(ctx, "degraded", "Telegram-Onboarding wartet auf die Datenbank", err)
			time.Sleep(2 * time.Second)
			continue
		}
		if request == nil {
			time.Sleep(2 * time.Second)
			continue
		}
		log.Printf("telegram onboarding request claimed request=%s account=%s", request.ID, request.AccountID)
		lease, err := a.acquire(ctx, "onboarding", request.AccountID)
		if err != nil || lease == nil {
			message := "Kein freier Telegram-Onboarding-Slot; QR-Anfrage bleibt in der Warteschlange"
			if err != nil {
				message = err.Error()
			}
			_, _ = a.db.Exec(ctx, "UPDATE connector_onboarding_requests SET status='pending',worker_id=NULL,error=$2,updated_at=NOW() WHERE id=$1::uuid", request.ID, message)
			waitStatus, waitDetail := a.waitStatus(ctx)
			a.setStatus(ctx, waitStatus, waitDetail, err)
			time.Sleep(2 * time.Second)
			continue
		}
		a.setLease(lease)
		a.mu.Lock()
		a.onboarding = request
		a.mu.Unlock()
		lease.startRenewal(func(renewErr error) {
			a.setStatus(context.Background(), "error", "Telegram-Onboarding-Lease verloren", renewErr)
			a.cancelCycle()
		})
		_ = lease.updateOnboarding(ctx, request.ID, "claimed", nil)
		_ = lease.setStatus(ctx, "pairing", nil)
		a.setStatus(ctx, "pairing", "Telegram-QR wird für den angemeldeten Nutzer erzeugt", nil)
		err = a.runTelegramCycle(ctx, request)
		if err != nil {
			log.Printf("telegram onboarding failed account=%s error=%v", request.AccountID, err)
			message := err.Error()
			_ = lease.updateQR(ctx, "failed", "", nil, &message)
			_ = lease.updateOnboarding(ctx, request.ID, "failed", &message)
			a.setStatus(ctx, "error", "Telegram-QR-Anmeldung fehlgeschlagen", err)
		} else {
			log.Printf("telegram onboarding completed account=%s; releasing dedicated slot", request.AccountID)
			_ = lease.updateQR(ctx, "completed", "", nil, nil)
			_ = lease.updateOnboarding(ctx, request.ID, "completed", nil)
			// The onboarding worker becomes idle, but the account itself must
			// remain eligible for the rotating processing pool. Calling setStatus
			// while the lease is attached would incorrectly persist "stopped" on
			// connector_accounts and leave the account with visible groups but no
			// message processing.
			_ = lease.setStatus(ctx, "paused", nil)
			a.setLease(nil)
			a.setStatus(ctx, "stopped", "Telegram-Onboarding abgeschlossen; Slot freigegeben", nil)
		}
		_ = lease.release(context.Background(), "onboarding_completed")
		a.setLease(nil)
		a.mu.Lock()
		a.onboarding = nil
		a.connectedAt = nil
		a.mu.Unlock()
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
			a.setStatus(ctx, "degraded", "Telegram-Processing konnte keine Lease beziehen", err)
			time.Sleep(a.cfg.PoolRetryDelay)
			continue
		}
		if lease == nil {
			waitStatus, waitDetail := a.waitStatus(ctx)
			a.setStatus(ctx, waitStatus, waitDetail, nil)
			time.Sleep(a.cfg.PoolRetryDelay)
			continue
		}
		log.Printf("telegram processing lease acquired account=%s worker=%s", lease.account.ID, lease.workerID)
		a.setLease(lease)
		lease.startRenewal(func(renewErr error) {
			a.setStatus(context.Background(), "error", "Telegram-Processing-Lease verloren", renewErr)
			a.cancelCycle()
		})
		_ = lease.setStatus(ctx, "connecting", nil)
		a.setStatus(ctx, "connecting", "Telegram-Connector-Slot verbunden", nil)
		err = a.runTelegramCycle(ctx, nil)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				a.setStatus(ctx, "stopped", "Telegram-Connector-Slot wurde freigegeben", nil)
			} else if strings.Contains(err.Error(), "TELEGRAM_REAUTH_REQUIRED") {
				message := err.Error()
				_ = lease.setStatus(ctx, "reauth_required", &message)
				a.setStatus(ctx, "reauth_required", "Telegram-Session muss erneut über QR angemeldet werden", err)
			} else {
				a.setStatus(ctx, "error", "Telegram-Verarbeitung fehlgeschlagen", err)
			}
		}
		if err != nil && strings.Contains(err.Error(), "TELEGRAM_REAUTH_REQUIRED") {
			log.Printf("telegram processing requires QR reauthentication account=%s", lease.account.ID)
			_ = lease.release(context.Background(), "reauth_required")
		} else {
			if err != nil {
				log.Printf("telegram processing failed account=%s error=%v", lease.account.ID, err)
			}
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
	if a.cfg.APIID <= 0 || a.cfg.APIHash == "" {
		a.setStatus(ctx, "degraded", "TG_API_ID und TG_API_HASH fehlen; Direct Telegram bleibt deaktiviert", nil)
		<-ctx.Done()
		return
	}
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
		log.Fatalf("Telegram gotd connector startup failed: %v", err)
	}
	defer a.close()
	server := &http.Server{Addr: ":" + cfg.Port, Handler: healthHandler(a), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := server.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("Telegram connector HTTP server stopped: %v", serveErr)
		}
	}()
	go a.run(ctx)
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	fmt.Println("Telegram gotd connector stopped")
}
