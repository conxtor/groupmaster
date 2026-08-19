package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

const (
	subjectMessageReceived = "wa.messages.received"
	subjectGroupDiscovered = "wa.groups.discovered"
	subjectMediaRequested  = "media.objects.requested"
	subjectAudioRequested  = "media.audio.requested"
	subjectConnectorStatus = "connector.status.changed"
	subjectGroupSelection  = "connector.group.selection.changed"
	subjectCleanup         = "internal.groups.cleanup.requested"
	subjectLogout          = "internal.connector.logout.requested"

	telegramConnector = "telegram"
)

type accountInfo struct {
	ID       string
	UserID   string
	Platform string
	Label    string
}

type onboardingInfo struct {
	ID        string
	AccountID string
	UserID    string
	Platform  string
}

type connectorLease struct {
	db           *pgxpool.Pool
	account      accountInfo
	workerID     string
	kind         string
	leaseSeconds int
	stopRenewal  context.CancelFunc
}

func (l *connectorLease) startRenewal(onError func(error)) {
	if l == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	l.stopRenewal = cancel
	interval := time.Duration(maxInt(10, l.leaseSeconds/3)) * time.Second
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := l.renew(context.Background()); err != nil {
					onError(err)
					return
				}
			}
		}
	}()
}

func (l *connectorLease) renew(ctx context.Context) error {
	var leaseUntil time.Time
	err := l.db.QueryRow(ctx, `
UPDATE connector_leases
SET lease_until=NOW()+($3::int * INTERVAL '1 second'), updated_at=NOW()
WHERE account_id=$1::uuid AND worker_id=$2 AND lease_until>NOW()
  AND ((lease_kind='onboarding' AND EXISTS (
    SELECT 1 FROM connector_onboarding_requests active
    WHERE active.account_id=$1::uuid AND active.status IN ('claimed','connected')
  )) OR (lease_kind='processing' AND NOT EXISTS (
    SELECT 1 FROM connector_onboarding_requests pending
    WHERE pending.account_id=$1::uuid AND pending.status IN ('pending','claimed','connected')
  )))
RETURNING lease_until`, l.account.ID, l.workerID, l.leaseSeconds).Scan(&leaseUntil)
	if err != nil {
		return fmt.Errorf("connector lease expired: %w", err)
	}
	_, _ = l.db.Exec(ctx, `UPDATE connector_lease_history SET lease_until=$3,last_seen_at=NOW() WHERE account_id=$1::uuid AND worker_id=$2 AND ended_at IS NULL`, l.account.ID, l.workerID, leaseUntil)
	return nil
}

func (l *connectorLease) setStatus(ctx context.Context, status string, lastError *string) error {
	_, err := l.db.Exec(ctx, `UPDATE connector_accounts
SET status=$2,last_error=$3,last_connected_at=CASE WHEN $2='ready' THEN NOW() ELSE last_connected_at END,updated_at=NOW()
WHERE id=$1::uuid`, l.account.ID, status, lastError)
	return err
}

func (l *connectorLease) saveSession(ctx context.Context, value []byte) error {
	_, err := l.db.Exec(ctx, `UPDATE connector_accounts SET session_data=$2,session_version=session_version+1,updated_at=NOW(),last_error=NULL WHERE id=$1::uuid`, l.account.ID, value)
	return err
}

func (l *connectorLease) loadSession(ctx context.Context) ([]byte, error) {
	var value []byte
	err := l.db.QueryRow(ctx, "SELECT session_data FROM connector_accounts WHERE id=$1::uuid", l.account.ID).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) || len(value) == 0 {
		return nil, session.ErrNotFound
	}
	// gotd stores a versioned JSON session. Invalid or incompatible persisted
	// data is treated as an absent session so QR onboarding can recover the
	// account.
	var persisted struct {
		Version int          `json:"Version"`
		Data    session.Data `json:"Data"`
	}
	if json.Unmarshal(value, &persisted) != nil || persisted.Version != 1 {
		return nil, session.ErrNotFound
	}
	return value, err
}

func (l *connectorLease) saveCursor(ctx context.Context, groupID, externalID string, receivedAt time.Time, sequence int) error {
	_, err := l.db.Exec(ctx, `INSERT INTO connector_cursors (account_id,group_id,last_external_message_id,last_received_at,last_sequence_no)
VALUES ($1::uuid,$2,$3,$4,$5)
ON CONFLICT (account_id,group_id) DO UPDATE SET
last_external_message_id=CASE WHEN COALESCE(EXCLUDED.last_sequence_no,0)>=COALESCE(connector_cursors.last_sequence_no,0) THEN EXCLUDED.last_external_message_id ELSE connector_cursors.last_external_message_id END,
last_received_at=CASE WHEN COALESCE(EXCLUDED.last_sequence_no,0)>=COALESCE(connector_cursors.last_sequence_no,0) THEN EXCLUDED.last_received_at ELSE connector_cursors.last_received_at END,
last_sequence_no=GREATEST(COALESCE(EXCLUDED.last_sequence_no,0),COALESCE(connector_cursors.last_sequence_no,0)),updated_at=NOW()`, l.account.ID, groupID, externalID, receivedAt, sequence)
	return err
}

func (l *connectorLease) loadCursor(ctx context.Context, groupID string) (int, error) {
	var value *int
	err := l.db.QueryRow(ctx, "SELECT last_sequence_no FROM connector_cursors WHERE account_id=$1::uuid AND group_id=$2", l.account.ID, groupID).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) || value == nil {
		return 0, nil
	}
	return *value, err
}

func (l *connectorLease) updateQR(ctx context.Context, status, payload string, expiresAt *time.Time, lastError *string) error {
	_, err := l.db.Exec(ctx, `INSERT INTO connector_qr_sessions (account_id,user_id,platform,status,qr_payload,expires_at,worker_id,last_error)
VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)
ON CONFLICT (account_id) DO UPDATE SET status=EXCLUDED.status,qr_payload=EXCLUDED.qr_payload,expires_at=EXCLUDED.expires_at,worker_id=EXCLUDED.worker_id,last_error=EXCLUDED.last_error,updated_at=NOW()`, l.account.ID, l.account.UserID, l.account.Platform, status, nullIfEmpty(payload), expiresAt, l.workerID, lastError)
	return err
}

func (l *connectorLease) updateOnboarding(ctx context.Context, requestID, status string, lastError *string) error {
	if requestID == "" {
		return nil
	}
	_, err := l.db.Exec(ctx, `UPDATE connector_onboarding_requests SET status=$2,worker_id=$3,error=$4,updated_at=NOW() WHERE id=$1::uuid AND account_id=$5::uuid`, requestID, status, l.workerID, lastError, l.account.ID)
	return err
}

func (l *connectorLease) release(ctx context.Context, reason string) error {
	if l == nil {
		return nil
	}
	if l.stopRenewal != nil {
		l.stopRenewal()
	}
	_, _ = l.db.Exec(ctx, `UPDATE connector_lease_history SET ended_at=NOW(),last_seen_at=NOW(),end_reason=$3 WHERE account_id=$1::uuid AND worker_id=$2 AND ended_at IS NULL`, l.account.ID, l.workerID, reason)
	_, err := l.db.Exec(ctx, "DELETE FROM connector_leases WHERE account_id=$1::uuid AND worker_id=$2", l.account.ID, l.workerID)
	return err
}

func (l *connectorLease) completeAndRelease(ctx context.Context, nextSync time.Time, reason string) error {
	_, _ = l.db.Exec(ctx, "UPDATE connector_accounts SET status='paused',last_sync_at=NOW(),next_sync_at=$2,last_error=NULL,updated_at=NOW() WHERE id=$1::uuid", l.account.ID, nextSync)
	return l.release(ctx, reason)
}

type postgresSession struct{ lease *connectorLease }

func (s *postgresSession) LoadSession(ctx context.Context) ([]byte, error) {
	return s.lease.loadSession(ctx)
}

func (s *postgresSession) StoreSession(ctx context.Context, data []byte) error {
	return s.lease.saveSession(ctx, data)
}

var _ session.Storage = (*postgresSession)(nil)

type app struct {
	cfg config
	db  *pgxpool.Pool
	nc  *nats.Conn
	js  nats.JetStreamContext

	mu              sync.RWMutex
	lease           *connectorLease
	onboarding      *onboardingInfo
	status          string
	statusDetail    string
	lastError       string
	connectedAt     *time.Time
	initialBackfill bool
	cycleCancel     context.CancelFunc
	client          *telegram.Client
	entities        map[string]*telegramEntity
	entitiesMu      sync.RWMutex
}

func randomID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return uuid.New().String()
	}
	return uuid.UUID(buf).String()
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (a *app) currentLease() *connectorLease {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.lease
}

func (a *app) setLease(lease *connectorLease) {
	a.mu.Lock()
	a.lease = lease
	a.mu.Unlock()
}

func (a *app) setCycleCancel(cancel context.CancelFunc) {
	a.mu.Lock()
	a.cycleCancel = cancel
	a.mu.Unlock()
}

func (a *app) cancelCycle() {
	a.mu.RLock()
	cancel := a.cycleCancel
	a.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
}

func (a *app) setStatus(ctx context.Context, status, detail string, errValue error) {
	a.mu.Lock()
	previousStatus := a.status
	previousDetail := a.statusDetail
	a.status = status
	a.statusDetail = detail
	if errValue != nil {
		a.lastError = errValue.Error()
	} else if status != "error" && status != "reauth_required" {
		a.lastError = ""
	}
	lastError := a.lastError
	connectedAt := a.connectedAt
	lease := a.lease
	a.mu.Unlock()
	if previousStatus != status || previousDetail != detail || errValue != nil {
		if errValue != nil {
			log.Printf("telegram status=%s detail=%q error=%v", status, detail, errValue)
		} else {
			log.Printf("telegram status=%s detail=%q", status, detail)
		}
	}

	var dbError *string
	if lastError != "" {
		dbError = &lastError
	}
	if lease != nil {
		_ = lease.setStatus(ctx, status, dbError)
	}
	connectedValue := any(nil)
	if connectedAt != nil {
		connectedValue = *connectedAt
	}
	_, _ = a.db.Exec(ctx, `INSERT INTO connector_states (connector,status,detail,last_error,connected_at)
VALUES ('telegram',$1,$2,$3,$4)
ON CONFLICT (connector) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,last_error=EXCLUDED.last_error,connected_at=EXCLUDED.connected_at,updated_at=NOW()`, status, detail, nullIfEmpty(lastError), connectedValue)
	if a.js != nil {
		_ = a.publish(subjectConnectorStatus, "connector.status.changed", map[string]any{
			"connector": "telegram", "status": status, "detail": detail,
			"lastError": nullIfEmpty(lastError), "connectedAt": connectedValue,
		})
	}
}

func (a *app) publish(subject, eventType string, data any) error {
	return a.publishWithID(subject, eventType, "", data)
}

// publishWithID keeps ordinary operational events unique per occurrence while
// allowing message revisions to use a stable logical event id. The NATS
// message-id header is intentionally not used; deduplication is handled by
// the database-backed event inbox consumers.
func (a *app) publishWithID(subject, eventType, eventID string, data any) error {
	if a.js == nil {
		return nil
	}
	if eventID == "" {
		eventID = randomID()
	}
	payload, err := json.Marshal(map[string]any{
		"id": eventID, "type": eventType, "occurredAt": time.Now().UTC().Format(time.RFC3339Nano), "source": "tg-connector", "data": data,
	})
	if err != nil {
		return err
	}
	_, err = a.js.Publish(subject, payload)
	return err
}

func (a *app) ensureStream(ctx context.Context) {
	if a.js == nil {
		return
	}
	info, err := a.js.StreamInfo("WAGI_EVENTS")
	if err != nil {
		_, err = a.js.AddStream(&nats.StreamConfig{Name: "WAGI_EVENTS", Subjects: []string{"wa.>", "media.>", "ai.>", "connector.>", "internal.>"}, Storage: nats.FileStorage, Retention: nats.LimitsPolicy, MaxAge: 30 * 24 * time.Hour})
		if err != nil {
			log.Printf("JetStream stream provisioning deferred: %v", err)
		}
		return
	}
	if info.Config.Name == "WAGI_EVENTS" {
		return
	}
	_ = ctx
}

func (a *app) waitStatus(ctx context.Context) (string, string) {
	var pending, active, accounts, eligible, reauth, stopped, disabled int
	_ = a.db.QueryRow(ctx, "SELECT COUNT(*) FROM connector_onboarding_requests WHERE platform='telegram' AND status IN ('pending','claimed','connected')").Scan(&pending)
	_ = a.db.QueryRow(ctx, "SELECT COUNT(*) FROM connector_leases l JOIN connector_accounts c ON c.id=l.account_id WHERE c.platform='telegram' AND l.lease_kind='processing' AND l.lease_until>NOW()").Scan(&active)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*),
COUNT(*) FILTER (WHERE status NOT IN ('disabled','stopped','reauth_required') AND session_data IS NOT NULL AND next_sync_at<=NOW()),
COUNT(*) FILTER (WHERE status='reauth_required'),
COUNT(*) FILTER (WHERE status='stopped'),
		COUNT(*) FILTER (WHERE status='disabled')
FROM connector_accounts WHERE platform='telegram'`).Scan(&accounts, &eligible, &reauth, &stopped, &disabled)
	if pending > 0 {
		return "waiting", fmt.Sprintf("Telegram-Onboarding wartet; Warteschlange %d, aktive Processing-Leases %d", pending, active)
	}
	if accounts == 0 {
		return "waiting", "Kein Telegram-Konto eingerichtet; zuerst eine direkte Telegram-Verbindung per QR starten"
	}
	if reauth > 0 && eligible == 0 {
		return "reauth_required", fmt.Sprintf("Telegram-Konto benötigt eine erneute QR-Anmeldung; reauth_required %d, gestoppt %d", reauth, stopped)
	}
	if eligible == 0 && stopped > 0 {
		return "stopped", fmt.Sprintf("Telegram-Konto ist gestoppt; QR-Anmeldung starten oder Konto reaktivieren; gestoppt %d, deaktiviert %d", stopped, disabled)
	}
	if eligible == 0 {
		return "waiting", fmt.Sprintf("Alle Telegram-Konten warten auf ihren nächsten Synchronisationszeitpunkt; Konten %d, aktive Processing-Leases %d", accounts, active)
	}
	return "waiting", fmt.Sprintf("Kein freier Telegram-Connector-Slot; Warteschlange %d, aktive Processing-Leases %d", pending, active)
}

func (a *app) waitDetail(ctx context.Context) string {
	_, detail := a.waitStatus(ctx)
	return detail
}

func (a *app) claimOnboarding(ctx context.Context) (*onboardingInfo, error) {
	_, _ = a.db.Exec(ctx, `UPDATE connector_onboarding_requests r SET status='pending',worker_id=NULL,updated_at=NOW()
WHERE r.platform='telegram' AND r.status='claimed' AND (NOT EXISTS (SELECT 1 FROM connector_leases l WHERE l.account_id=r.account_id AND l.lease_kind='onboarding' AND l.lease_until>NOW()) OR EXISTS (SELECT 1 FROM connector_qr_sessions q WHERE q.account_id=r.account_id AND (q.status IN ('expired','failed','cancelled') OR q.expires_at<=NOW())))`)
	_, _ = a.db.Exec(ctx, `UPDATE connector_leases l SET lease_until=NOW(),updated_at=NOW() WHERE l.lease_kind='onboarding' AND EXISTS (SELECT 1 FROM connector_onboarding_requests p WHERE p.account_id=l.account_id AND p.platform='telegram' AND p.status='pending')`)
	var result onboardingInfo
	err := a.db.QueryRow(ctx, `WITH candidate AS (SELECT id FROM connector_onboarding_requests WHERE platform='telegram' AND status='pending' ORDER BY updated_at DESC,created_at DESC FOR UPDATE SKIP LOCKED LIMIT 1)
UPDATE connector_onboarding_requests r SET status='claimed',worker_id=$1,updated_at=NOW() FROM candidate WHERE r.id=candidate.id
RETURNING r.id::text,r.account_id::text,r.user_id::text,r.platform`, a.cfg.WorkerID).Scan(&result.ID, &result.AccountID, &result.UserID, &result.Platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *app) acquire(ctx context.Context, kind, preferred string) (*connectorLease, error) {
	var accountID string
	var preferredValue any
	if preferred != "" {
		preferredValue = preferred
	}
	limit := a.cfg.PoolSize
	if kind == "onboarding" {
		limit = a.cfg.OnboardingSlots
	}
	err := a.db.QueryRow(ctx, `WITH candidate AS (
SELECT ca.id FROM connector_accounts ca LEFT JOIN connector_leases cl ON cl.account_id=ca.id
WHERE ca.platform='telegram' AND ca.status NOT IN ('disabled','stopped')
AND ($4::text='onboarding' OR ca.status<>'reauth_required')
AND (cl.account_id IS NULL OR cl.lease_until<=NOW() OR cl.worker_id=$1 OR ($4::text='onboarding' AND cl.lease_kind='processing' AND EXISTS (SELECT 1 FROM connector_onboarding_requests requested WHERE requested.account_id=ca.id AND requested.status IN ('pending','claimed','connected'))))
AND ($2::uuid IS NULL OR ca.id=$2::uuid)
AND ($4::text='onboarding' OR ca.next_sync_at<=NOW() OR ca.id=$2::uuid)
AND ($4::text='onboarding' OR ca.session_data IS NOT NULL)
AND ($4::text='onboarding' OR NOT EXISTS (SELECT 1 FROM connector_onboarding_requests pending WHERE pending.account_id=ca.id AND pending.status IN ('pending','claimed','connected')))
AND (SELECT COUNT(*) FROM connector_leases active JOIN connector_accounts aa ON aa.id=active.account_id WHERE aa.platform='telegram' AND active.lease_kind=$4 AND active.lease_until>NOW() AND active.worker_id<>$1) < $5
ORDER BY CASE WHEN $2::uuid IS NOT NULL AND ca.id=$2::uuid THEN 0 ELSE 1 END,ca.next_sync_at,ca.created_at
FOR UPDATE OF ca SKIP LOCKED LIMIT 1)
INSERT INTO connector_leases (account_id,worker_id,lease_until,lease_kind,updated_at)
SELECT id,$1,NOW()+($3::int*INTERVAL '1 second'),$4,NOW() FROM candidate
ON CONFLICT (account_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,lease_until=EXCLUDED.lease_until,lease_kind=EXCLUDED.lease_kind,updated_at=NOW()
RETURNING account_id::text`, a.cfg.WorkerID, preferredValue, a.cfg.LeaseSeconds, kind, limit).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_, _ = a.db.Exec(ctx, `UPDATE connector_lease_history SET ended_at=COALESCE(ended_at,NOW()),last_seen_at=NOW(),end_reason=COALESCE(end_reason,'replaced') WHERE account_id=$1::uuid AND ended_at IS NULL`, accountID)
	_, _ = a.db.Exec(ctx, `INSERT INTO connector_lease_history (account_id,user_id,platform,lease_kind,worker_id,lease_until)
SELECT l.account_id,ca.user_id,ca.platform,l.lease_kind,l.worker_id,l.lease_until FROM connector_leases l JOIN connector_accounts ca ON ca.id=l.account_id WHERE l.account_id=$1::uuid AND l.worker_id=$2 AND l.lease_kind=$3`, accountID, a.cfg.WorkerID, kind)
	var account accountInfo
	err = a.db.QueryRow(ctx, "SELECT id::text,user_id::text,platform,label FROM connector_accounts WHERE id=$1::uuid", accountID).Scan(&account.ID, &account.UserID, &account.Platform, &account.Label)
	if err != nil {
		return nil, err
	}
	return &connectorLease{db: a.db, account: account, workerID: a.cfg.WorkerID, kind: kind, leaseSeconds: a.cfg.LeaseSeconds}, nil
}

func (a *app) cleanupGroups(ctx context.Context, groupIDs []string) {
	if len(groupIDs) == 0 || a.cfg.MediaCleanupToken == "" {
		return
	}
	_ = a.nc.PublishRequest(subjectCleanup, "", mustJSON(map[string]any{
		"token": a.cfg.MediaCleanupToken, "platform": "telegram", "groupIds": groupIDs,
	}))
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func (a *app) handleLogout(ctx context.Context, accountID string) bool {
	lease := a.currentLease()
	if lease == nil || lease.account.ID != accountID {
		return false
	}
	a.setStatus(ctx, "stopped", "Telegram-Sitzung wird abgemeldet", nil)
	a.mu.RLock()
	client := a.client
	a.mu.RUnlock()
	if client != nil {
		// Remove this authorization from Telegram before the durable account row
		// is deleted. Otherwise every reconnect can leave another device session
		// visible in Telegram's active sessions list.
		if _, err := client.API().AuthLogOut(ctx); err != nil {
			log.Printf("Telegram server-side logout failed for %s: %v", accountID, err)
		} else {
			_ = lease.saveSession(ctx, nil)
		}
	}
	a.cancelCycle()
	return true
}

func (a *app) startSubscriptions(ctx context.Context) {
	selection, err := a.nc.SubscribeSync(subjectGroupSelection)
	if err == nil {
		go func() {
			for {
				message, nextErr := selection.NextMsg(10 * time.Second)
				if nextErr != nil {
					if errors.Is(nextErr, nats.ErrTimeout) {
						continue
					}
					return
				}
				var envelope struct {
					Data struct {
						GroupID  string `json:"groupId"`
						Selected bool   `json:"selected"`
						Platform string `json:"platform"`
						UserID   string `json:"userId"`
					} `json:"data"`
				}
				if json.Unmarshal(message.Data, &envelope) == nil && envelope.Data.Platform != "whatsapp" {
					go a.handleSelection(ctx, envelope.Data.GroupID, envelope.Data.Selected, envelope.Data.UserID)
				}
			}
		}()
	}
	logout, err := a.nc.SubscribeSync(subjectLogout)
	if err == nil {
		go func() {
			for {
				message, nextErr := logout.NextMsg(10 * time.Second)
				if nextErr != nil {
					if errors.Is(nextErr, nats.ErrTimeout) {
						continue
					}
					return
				}
				var payload struct {
					Token     string `json:"token"`
					Platform  string `json:"platform"`
					AccountID string `json:"accountId"`
				}
				if json.Unmarshal(message.Data, &payload) != nil || payload.Token != a.cfg.MediaCleanupToken || payload.Platform != "telegram" || payload.AccountID == "" {
					continue
				}
				if a.handleLogout(ctx, payload.AccountID) {
					_ = message.Respond(mustJSON(map[string]any{"ok": true, "platform": "telegram", "accountId": payload.AccountID}))
				}
			}
		}()
	}
}

func (a *app) handleSelection(ctx context.Context, groupID string, selected bool, userID string) {
	if groupID == "" || len(groupID) < 3 || groupID[:3] != "tg:" {
		return
	}
	if userID == "" {
		if lease := a.currentLease(); lease != nil {
			userID = lease.account.UserID
		}
	}
	if userID == "" {
		log.Printf("telegram group selection ignored without user id group=%s", groupID)
		return
	}
	if _, err := a.db.Exec(ctx, `INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected) VALUES ($1::uuid,$2,TRUE,TRUE,$3)
ON CONFLICT (user_id,group_id) DO UPDATE SET is_selected=EXCLUDED.is_selected`, userID, groupID, selected); err != nil {
		log.Printf("telegram group selection persistence failed group=%s user=%s error=%v", groupID, userID, err)
		return
	}
	if selected {
		// The rotating pool deliberately releases its lease after every cycle.
		// Make a newly selected group wake the next eligible processing cycle
		// instead of waiting for the previous sync interval.
		_, _ = a.db.Exec(ctx, `UPDATE connector_accounts
SET next_sync_at=NOW(),updated_at=NOW()
WHERE platform='telegram' AND user_id=$1::uuid AND status NOT IN ('disabled','stopped')`, userID)
	}
	log.Printf("telegram group selection persisted group=%s selected=%t user=%s", groupID, selected, userID)
}

func (a *app) statusSnapshot() map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	connected := a.connectedAt
	var connectedValue any
	if connected != nil {
		connectedValue = connected.Format(time.RFC3339)
	}
	lease := a.lease
	var account any
	if lease != nil {
		account = map[string]any{"id": lease.account.ID, "userId": lease.account.UserID, "label": lease.account.Label, "kind": lease.kind, "workerId": lease.workerID}
	}
	return map[string]any{"connector": "telegram", "status": a.status, "mode": "telegram-direct-gotd", "connected": connected != nil, "connectedAt": connectedValue, "lastError": nullIfEmpty(a.lastError), "account": account, "poolEnabled": a.cfg.PoolEnabled, "poolSize": a.cfg.PoolSize, "onboardingSlots": a.cfg.OnboardingSlots, "backfillDays": a.cfg.BackfillDays, "backfillThrottleMs": a.cfg.BackfillThrottle.Milliseconds()}
}

func healthHandler(a *app) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/healthz":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(mustJSON(map[string]any{"status": "ok", "service": "tg-connector", "implementation": "gotd/td"}))
		case "/readyz":
			a.mu.RLock()
			ready := a.status == "ready" || a.status == "pairing" || a.status == "syncing"
			a.mu.RUnlock()
			if !ready {
				w.WriteHeader(http.StatusServiceUnavailable)
			} else {
				w.WriteHeader(http.StatusOK)
			}
			_, _ = w.Write(mustJSON(a.statusSnapshot()))
		case "/status":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(mustJSON(a.statusSnapshot()))
		case "/auth/qr":
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write(mustJSON(map[string]any{"error": "QR wird über die API und connector_qr_sessions geroutet"}))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write(mustJSON(map[string]string{"error": "not found"}))
		}
	})
}
