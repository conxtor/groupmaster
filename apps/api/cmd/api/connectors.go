package main

import (
	"encoding/json"
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

type connectorAccountRequest struct {
	Platform string `json:"platform"`
	Label    string `json:"label"`
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
	if r.Method != http.MethodPatch {
		w.Header().Set("allow", http.MethodPatch)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	accountID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/connectors/accounts/"), "/")
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

func itoa(value int) string {
	return strconv.Itoa(value)
}
