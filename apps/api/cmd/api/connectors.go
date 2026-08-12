package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type connectorAccountView struct {
	ID                string     `json:"id"`
	Platform          string     `json:"platform"`
	Label             string     `json:"label"`
	Status            string     `json:"status"`
	ExternalAccountID *string    `json:"externalAccountId,omitempty"`
	LastError         *string    `json:"lastError,omitempty"`
	LastConnectedAt   *time.Time `json:"lastConnectedAt,omitempty"`
	LastSyncAt        *time.Time `json:"lastSyncAt,omitempty"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

type connectorQRView struct {
	AccountID     string     `json:"accountId"`
	Platform      string     `json:"platform"`
	Status        string     `json:"status"`
	Connected     bool       `json:"connected"`
	QR            *string    `json:"qr,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt,omitempty"`
	LastError     *string    `json:"lastError,omitempty"`
	RequestID     *string    `json:"requestId,omitempty"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	QueuePosition *int       `json:"queuePosition,omitempty"`
	QueueLength   *int       `json:"queueLength,omitempty"`
	WaitReason    *string    `json:"waitReason,omitempty"`
	LeaseKind     *string    `json:"leaseKind,omitempty"`
}

type connectorAccountRequest struct {
	Platform string `json:"platform"`
	Label    string `json:"label"`
}

// requestConnectorLogout asks the pool worker that currently owns the account
// to close the live client before the durable account/session rows are removed.
// The request is deliberately best effort: an account may be between pool
// leases, in which case there is no live process to stop.
func (a *app) requestConnectorLogout(platform, accountID string) {
	if a.nc == nil || a.nc.IsClosed() || a.mediaCleanupToken == "" {
		return
	}
	payload, err := json.Marshal(map[string]string{
		"token":     a.mediaCleanupToken,
		"platform":  platform,
		"accountId": accountID,
	})
	if err != nil {
		return
	}
	if _, err := a.nc.Request("internal.connector.logout.requested", payload, 3*time.Second); err != nil {
		// No active worker is a valid state in the rotating pool. The database
		// cleanup below still removes the durable session and prevents reuse.
		log.Printf("connector logout handoff for %s/%s did not reach an active worker: %v", platform, accountID, err)
	}
}

func (a *app) requestMediaCleanup(platform string, groupIDs []string) error {
	if len(groupIDs) == 0 {
		return nil
	}
	if a.nc == nil || a.nc.IsClosed() {
		return fmt.Errorf("NATS ist für die Medienbereinigung nicht verfügbar")
	}
	if a.mediaCleanupToken == "" {
		return fmt.Errorf("MEDIA_CLEANUP_TOKEN ist nicht konfiguriert")
	}
	payload, err := json.Marshal(map[string]any{
		"token":    a.mediaCleanupToken,
		"platform": platform,
		"groupIds": groupIDs,
	})
	if err != nil {
		return err
	}
	response, err := a.nc.Request("internal.groups.cleanup.requested", payload, 30*time.Second)
	if err != nil {
		return fmt.Errorf("Medienbereinigung konnte nicht gestartet werden: %w", err)
	}
	var result struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(response.Data, &result); err != nil {
		return fmt.Errorf("ungültige Antwort der Medienbereinigung: %w", err)
	}
	if !result.OK {
		if result.Error == "" {
			result.Error = "unbekannter Fehler"
		}
		return fmt.Errorf("Medienbereinigung fehlgeschlagen: %s", result.Error)
	}
	return nil
}

// logoutConnectorAccount removes only data that belongs to this user's
// connector. Shared groups lose this user's access but remain available for
// other users; exclusively owned groups are deleted and their message/media
// rows follow the database foreign-key cascades.
func (a *app) logoutConnectorAccount(ctx context.Context, accountID, platform, ownerUserID string) (int, error) {
	if _, err := a.db.Exec(ctx, `UPDATE connector_onboarding_requests SET status='cancelled', worker_id=NULL, updated_at=NOW()
		WHERE account_id=$1::uuid AND status IN ('pending','claimed','connected')`, accountID); err != nil {
		return 0, err
	}
	if _, err := a.db.Exec(ctx, `UPDATE connector_qr_sessions SET status='cancelled', qr_payload=NULL, expires_at=NULL, updated_at=NOW()
		WHERE account_id=$1::uuid`, accountID); err != nil {
		return 0, err
	}
	if _, err := a.db.Exec(ctx, `UPDATE connector_accounts SET status='stopped', last_error=NULL, updated_at=NOW()
		WHERE id=$1::uuid`, accountID); err != nil {
		return 0, err
	}

	// Stop an in-memory Baileys/GramJS client before deleting its lease and
	// session state. Every connector worker receives this internal event; only
	// the worker owning this account responds.
	a.requestConnectorLogout(platform, accountID)

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT g.id
		FROM wa_groups g
		WHERE g.platform=$2
		  AND NOT EXISTS (
			SELECT 1 FROM user_group_access other
			WHERE other.group_id=g.id AND other.user_id<>$1::uuid
		  )
		  AND (
			g.owner_user_id=$1::uuid
			OR (g.owner_user_id IS NULL AND EXISTS (
				SELECT 1 FROM user_group_access own WHERE own.group_id=g.id AND own.user_id=$1::uuid
			))
		  )
		FOR UPDATE`, ownerUserID, platform)
	if err != nil {
		return 0, err
	}
	groupIDs := make([]string, 0)
	for rows.Next() {
		var groupID string
		if err := rows.Scan(&groupID); err != nil {
			rows.Close()
			return 0, err
		}
		groupIDs = append(groupIDs, groupID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	if err := a.requestMediaCleanup(platform, groupIDs); err != nil {
		return 0, err
	}
	// Remove access to every group of this service. This also hides shared
	// groups from the user while leaving their other users' access untouched.
	if _, err := tx.Exec(ctx, `DELETE FROM user_group_access
		WHERE user_id=$1::uuid AND group_id IN (SELECT id FROM wa_groups WHERE platform=$2)`, ownerUserID, platform); err != nil {
		return 0, err
	}
	if len(groupIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM wa_groups WHERE platform=$1 AND id=ANY($2::text[])
			AND NOT EXISTS (SELECT 1 FROM user_group_access other WHERE other.group_id=wa_groups.id)`, platform, groupIDs); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM connector_accounts WHERE id=$1::uuid", accountID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(groupIDs), nil
}

func intPointer(value int) *int { return &value }

func stringPointer(value string) *string { return &value }

// connectorQueueInfo describes both the dedicated QR slot and the rotating
// processing pool. It is deliberately calculated from live leases so the UI
// can distinguish "waiting for a slot" from an actual connector error.
func (a *app) connectorQueueInfo(ctx context.Context, accountID, platform string) (queuePosition, queueLength *int, waitReason, leaseKind *string, err error) {
	var accountStatus string
	var sessionAvailable bool
	var requestStatus *string
	var activeLeaseKind *string
	var pendingRequests, activeOnboarding, activeProcessing int
	var pendingPosition *int
	err = a.db.QueryRow(ctx, `
		SELECT ca.status, ca.session_data IS NOT NULL, latest.status, active.lease_kind,
			(SELECT COUNT(*)::int FROM connector_onboarding_requests pending
			 WHERE pending.platform=$2 AND pending.status='pending'),
			(SELECT COUNT(*)::int FROM connector_leases onboarding
			 JOIN connector_accounts onboarding_account ON onboarding_account.id=onboarding.account_id
			 WHERE onboarding_account.platform=$2 AND onboarding.lease_kind='onboarding' AND onboarding.lease_until>NOW()),
			(SELECT COUNT(*)::int FROM connector_leases processing
			 JOIN connector_accounts processing_account ON processing_account.id=processing.account_id
			 WHERE processing_account.platform=$2 AND processing.lease_kind='processing' AND processing.lease_until>NOW()),
			CASE WHEN latest.status='pending' THEN (
				SELECT COUNT(*)::int + 1 FROM connector_onboarding_requests earlier
				WHERE earlier.platform=$2 AND earlier.status='pending'
				  AND (earlier.updated_at > latest.updated_at
				       OR (earlier.updated_at=latest.updated_at AND earlier.created_at > latest.created_at))
			) END
		FROM connector_accounts ca
		LEFT JOIN connector_leases active ON active.account_id=ca.id AND active.lease_until>NOW()
		LEFT JOIN LATERAL (
			SELECT request.status, request.updated_at, request.created_at
			FROM connector_onboarding_requests request
			WHERE request.account_id=ca.id AND request.status IN ('pending','claimed','connected')
			ORDER BY request.created_at DESC LIMIT 1
		) latest ON TRUE
		WHERE ca.id=$1::uuid AND ca.platform=$2`, accountID, platform).
		Scan(&accountStatus, &sessionAvailable, &requestStatus, &activeLeaseKind, &pendingRequests, &activeOnboarding, &activeProcessing, &pendingPosition)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	if activeLeaseKind != nil {
		leaseKind = activeLeaseKind
	}
	if requestStatus != nil {
		switch *requestStatus {
		case "pending":
			queuePosition = pendingPosition
			queueLength = intPointer(pendingRequests)
			if activeOnboarding >= a.onboardingSlots(platform) {
				waitReason = stringPointer("onboarding_slot")
			} else {
				waitReason = stringPointer("onboarding_queue")
			}
		case "claimed", "connected":
			if activeLeaseKind == nil || *activeLeaseKind != "onboarding" {
				queuePosition = intPointer(1)
				queueLength = intPointer(pendingRequests + 1)
				waitReason = stringPointer("onboarding_slot")
			}
		}
		return queuePosition, queueLength, waitReason, leaseKind, nil
	}

	// After a successful QR onboarding, the account is paused until the
	// rotating processing pool claims it. Expose that short wait instead of
	// presenting the misleading QR/authentication message again.
	if sessionAvailable && (accountStatus == "paused" || accountStatus == "degraded" || accountStatus == "disconnected") {
		var position, total int
		processingErr := a.db.QueryRow(ctx, `
			WITH eligible AS (
				SELECT ca.id, ROW_NUMBER() OVER (ORDER BY ca.next_sync_at, ca.created_at)::int AS position,
					COUNT(*) OVER ()::int AS total
				FROM connector_accounts ca
				WHERE ca.platform=$1 AND ca.status IN ('disconnected','paused','degraded')
				  AND ca.session_data IS NOT NULL AND ca.next_sync_at<=NOW()
				  AND NOT EXISTS (
					SELECT 1 FROM connector_onboarding_requests active_onboarding
					WHERE active_onboarding.account_id=ca.id AND active_onboarding.status IN ('pending','claimed','connected')
				  )
				  AND NOT EXISTS (
					SELECT 1 FROM connector_leases active_processing
					WHERE active_processing.account_id=ca.id AND active_processing.lease_kind='processing' AND active_processing.lease_until>NOW()
				  )
			)
			SELECT position,total FROM eligible WHERE id=$2::uuid`, platform, accountID).Scan(&position, &total)
		if processingErr == nil {
			return intPointer(position), intPointer(total), stringPointer("processing_slot"), leaseKind, nil
		}
	}

	_ = activeProcessing
	return nil, nil, nil, leaseKind, nil
}

func (a *app) onboardingSlots(platform string) int {
	if platform == "telegram" {
		return a.tgOnboardingSlots
	}
	return a.waOnboardingSlots
}

func (a *app) connectorAccounts(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		where := "ca.user_id=$1::uuid"
		args := []any{user.ID}
		if user.isAdmin() && r.URL.Query().Get("all") == "true" {
			where = "TRUE"
			args = nil
		}
		rows, err := a.db.Query(r.Context(), `SELECT ca.id::text, ca.platform, ca.label, ca.status, ca.external_account_id, ca.last_error, ca.last_connected_at, ca.last_sync_at, ca.updated_at FROM connector_accounts ca WHERE `+where+` ORDER BY ca.platform, ca.created_at`, args...)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "connector accounts unavailable"})
			return
		}
		defer rows.Close()
		result := make([]connectorAccountView, 0)
		for rows.Next() {
			var item connectorAccountView
			if err := rows.Scan(&item.ID, &item.Platform, &item.Label, &item.Status, &item.ExternalAccountID, &item.LastError, &item.LastConnectedAt, &item.LastSyncAt, &item.UpdatedAt); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "connector accounts unavailable"})
				return
			}
			result = append(result, item)
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var request connectorAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request.Platform = strings.ToLower(strings.TrimSpace(request.Platform))
	request.Label = strings.TrimSpace(request.Label)
	if request.Platform != "whatsapp" && request.Platform != "telegram" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "platform must be whatsapp or telegram"})
		return
	}
	if request.Label == "" {
		request.Label = strings.Title(request.Platform) //nolint:staticcheck // readable local UI label
	}
	var item connectorAccountView
	err := a.db.QueryRow(r.Context(), `
		INSERT INTO connector_accounts (user_id, platform, label)
		VALUES ($1::uuid,$2,$3)
		ON CONFLICT (user_id,platform) DO UPDATE SET label=EXCLUDED.label, updated_at=NOW()
		RETURNING id::text, platform, label, status, external_account_id, last_error, last_connected_at, last_sync_at, updated_at`, user.ID, request.Platform, request.Label).
		Scan(&item.ID, &item.Platform, &item.Label, &item.Status, &item.ExternalAccountID, &item.LastError, &item.LastConnectedAt, &item.LastSyncAt, &item.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "connector account could not be created"})
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *app) connectorAccountAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/connectors/accounts/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[1] == "qr" {
		a.connectorAccountQR(w, r, parts[0], user)
		return
	}
	if r.Method != http.MethodPatch {
		w.Header().Set("allow", http.MethodPatch)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	accountID := strings.Trim(parts[0], "/")
	if _, err := uuid.Parse(accountID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connector account"})
		return
	}
	var body struct {
		Status string `json:"status"`
		Label  string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	allowedStatus := map[string]bool{"paused": true, "disconnected": true, "stopped": true}
	if !user.isAdmin() && body.Status != "" && !allowedStatus[body.Status] {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "users can only pause or stop their own connector"})
		return
	}
	if body.Status != "" && !map[string]bool{"disconnected": true, "pairing": true, "connecting": true, "syncing": true, "ready": true, "paused": true, "degraded": true, "error": true, "reauth_required": true, "stopped": true}[body.Status] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connector status"})
		return
	}
	args := []any{accountID, user.ID}
	where := "ca.id=$1::uuid AND ca.user_id=$2::uuid"
	if user.isAdmin() {
		args = args[:1]
		where = "ca.id=$1::uuid"
	}
	query := `UPDATE connector_accounts ca SET status=COALESCE(NULLIF($` + itoa(len(args)+1) + `,''),ca.status), label=COALESCE(NULLIF($` + itoa(len(args)+2) + `,''),ca.label), updated_at=NOW() WHERE ` + where + ` RETURNING ca.id::text, ca.platform, ca.label, ca.status, ca.external_account_id, ca.last_error, ca.last_connected_at, ca.last_sync_at, ca.updated_at`
	args = append(args, body.Status, strings.TrimSpace(body.Label))
	var item connectorAccountView
	if err := a.db.QueryRow(r.Context(), query, args...).Scan(&item.ID, &item.Platform, &item.Label, &item.Status, &item.ExternalAccountID, &item.LastError, &item.LastConnectedAt, &item.LastSyncAt, &item.UpdatedAt); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "connector account not found"})
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *app) connectorAccountQR(w http.ResponseWriter, r *http.Request, accountID string, user *authenticatedUser) {
	if _, err := uuid.Parse(accountID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connector account"})
		return
	}
	ownerClause := "ca.user_id=$2::uuid"
	ownerArgs := []any{accountID, user.ID}
	if user.isAdmin() {
		ownerClause = "ca.id=$1::uuid"
		ownerArgs = []any{accountID}
	}
	var platform string
	var accountOwnerID string
	if err := a.db.QueryRow(r.Context(), "SELECT platform, user_id::text FROM connector_accounts ca WHERE ca.id=$1::uuid AND "+ownerClause, ownerArgs...).Scan(&platform, &accountOwnerID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "connector account not found"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		var view connectorQRView
		var requestID *string
		err := a.db.QueryRow(r.Context(), `SELECT ca.id::text, ca.platform,
			CASE
				-- A persisted session is authoritative. A stale QR row must not
				-- make an already authenticated pool account look like it is still
				-- waiting for a QR code after a restart.
				WHEN ca.session_data IS NOT NULL AND ca.status IN ('ready','connecting','syncing','paused','degraded') THEN ca.status
				WHEN ca.status IN ('ready','connecting','syncing','paused','degraded') AND q.status IN ('failed','expired','cancelled') THEN ca.status
				ELSE COALESCE(q.status, ca.status)
			END,
			(ca.session_data IS NOT NULL AND ca.status NOT IN ('pairing','reauth_required','stopped')),
			q.qr_payload, q.expires_at,
			CASE WHEN ca.session_data IS NOT NULL AND ca.status IN ('ready','connecting','syncing','paused','degraded') THEN ca.last_error
				 WHEN ca.status IN ('ready','connecting','syncing','paused','degraded') AND q.status IN ('failed','expired','cancelled') THEN ca.last_error
				 ELSE q.last_error END,
			COALESCE(q.updated_at, ca.updated_at), latest.id::text
			FROM connector_accounts ca
			LEFT JOIN connector_qr_sessions q ON q.account_id=ca.id
			LEFT JOIN LATERAL (SELECT id FROM connector_onboarding_requests WHERE account_id=ca.id AND status IN ('pending','claimed','connected') ORDER BY created_at DESC LIMIT 1) latest ON TRUE
			WHERE ca.id=$1::uuid`, accountID).Scan(&view.AccountID, &view.Platform, &view.Status, &view.Connected, &view.QR, &view.ExpiresAt, &view.LastError, &view.UpdatedAt, &requestID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "connector account not found"})
			return
		}
		view.RequestID = requestID
		queuePosition, queueLength, waitReason, leaseKind, queueErr := a.connectorQueueInfo(r.Context(), accountID, platform)
		if queueErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "connector queue unavailable"})
			return
		}
		view.QueuePosition = queuePosition
		view.QueueLength = queueLength
		view.WaitReason = waitReason
		view.LeaseKind = leaseKind
		if view.ExpiresAt != nil && view.ExpiresAt.Before(time.Now()) && view.QR != nil {
			view.QR = nil
			view.Status = "expired"
		}
		writeJSON(w, http.StatusOK, view)
	case http.MethodPost:
		// A second click must be able to recover a worker that is still marked
		// as claimed after a stalled MTProto/Baileys login. Keep the old request
		// as a cancelled audit record and enqueue a fresh request for this user.
		_, _ = a.db.Exec(r.Context(), `UPDATE connector_onboarding_requests
			SET status='cancelled', worker_id=NULL, error='QR-Onboarding neu gestartet', updated_at=NOW()
			WHERE account_id=$1::uuid AND status IN ('pending','claimed','connected')`, accountID)
		var requestID string
		err := a.db.QueryRow(r.Context(), `INSERT INTO connector_onboarding_requests (account_id,user_id,platform,status)
			SELECT ca.id, ca.user_id, ca.platform, 'pending' FROM connector_accounts ca
			WHERE ca.id=$1::uuid
			RETURNING id::text`, accountID).Scan(&requestID)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "QR-Onboarding konnte nicht gestartet werden"})
			return
		}
		_, _ = a.db.Exec(r.Context(), `INSERT INTO connector_qr_sessions (account_id,user_id,platform,status,qr_payload,expires_at,last_error)
			SELECT id,user_id,platform,'starting',NULL,NULL,NULL FROM connector_accounts WHERE id=$1::uuid
			ON CONFLICT (account_id) DO UPDATE SET status='starting', qr_payload=NULL, expires_at=NULL, last_error=NULL, updated_at=NOW()`, accountID)
		// A QR request is an explicit handoff from the rotating processing pool
		// to the dedicated onboarding slot. The old worker will fail its next
		// lease renewal because the request is pending and then close its socket.
		_, _ = a.db.Exec(r.Context(), `UPDATE connector_leases SET lease_until=NOW(), updated_at=NOW()
			WHERE account_id=$1::uuid AND lease_kind IN ('processing','onboarding')`, accountID)
		_, _ = a.db.Exec(r.Context(), "UPDATE connector_accounts SET status='pairing', last_error=NULL, updated_at=NOW() WHERE id=$1::uuid", accountID)
		writeJSON(w, http.StatusAccepted, map[string]any{"accountId": accountID, "platform": platform, "status": "starting", "requestId": requestID})
	case http.MethodDelete:
		deletedGroups, err := a.logoutConnectorAccount(r.Context(), accountID, platform, accountOwnerID)
		if err != nil {
			log.Printf("connector logout failed for %s/%s: %v", platform, accountID, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Connector konnte nicht vollständig abgemeldet und bereinigt werden"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "logged_out", "deletedGroups": deletedGroups})
	default:
		w.Header().Set("allow", "GET, POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
