package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type adminUserView struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Roles     []string  `json:"roles"`
	CreatedAt time.Time `json:"createdAt"`
}

type adminGroupAccessView struct {
	GroupID       string  `json:"groupId"`
	Subject       string  `json:"subject"`
	Platform      string  `json:"platform"`
	ChatType      string  `json:"chatType"`
	ParentGroupID *string `json:"parentGroupId,omitempty"`
	TopicID       *int64  `json:"topicId,omitempty"`
	IsSelected    bool    `json:"isSelected"`
	CanRead       bool    `json:"canRead"`
	CanManage     bool    `json:"canManage"`
}

func (a *app) adminUsers(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/users")
	if path == "" || path == "/" {
		if r.Method != http.MethodGet {
			w.Header().Set("allow", http.MethodGet)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		a.listAdminUsers(w, r)
		return
	}
	if r.Method != http.MethodPatch {
		w.Header().Set("allow", http.MethodPatch)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	a.updateAdminUser(w, r, strings.Trim(path, "/"))
}

func (a *app) listAdminUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT u.id::text, u.email, u.name, u.status,
		       COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}'), u.created_at
		FROM app_users u LEFT JOIN user_roles ur ON ur.user_id=u.id
		GROUP BY u.id, u.email, u.name, u.status, u.created_at
		ORDER BY u.created_at ASC, u.email`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "users unavailable"})
		return
	}
	defer rows.Close()
	result := make([]adminUserView, 0)
	for rows.Next() {
		var item adminUserView
		if err := rows.Scan(&item.ID, &item.Email, &item.Name, &item.Status, &item.Roles, &item.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "users unavailable"})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *app) updateAdminUser(w http.ResponseWriter, r *http.Request, userID string) {
	var request roleRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if request.Role != "admin" && request.Role != "user" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be admin or user"})
		return
	}
	if request.Status != "active" && request.Status != "disabled" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status must be active or disabled"})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user update unavailable"})
		return
	}
	defer tx.Rollback(r.Context())
	if request.Role != "admin" || request.Status == "disabled" {
		var adminCount int
		if err := tx.QueryRow(r.Context(), `SELECT COUNT(*) FROM app_users u JOIN user_roles ur ON ur.user_id=u.id AND ur.role_name='admin' WHERE u.status='active' AND u.id=$1::uuid`, userID).Scan(&adminCount); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid user"})
			return
		}
		if adminCount > 0 {
			var activeAdmins int
			if err := tx.QueryRow(r.Context(), `SELECT COUNT(*) FROM app_users u JOIN user_roles ur ON ur.user_id=u.id AND ur.role_name='admin' WHERE u.status='active'`).Scan(&activeAdmins); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user update unavailable"})
				return
			}
			if activeAdmins <= 1 {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "at least one active administrator is required"})
				return
			}
		}
	}
	if _, err := tx.Exec(r.Context(), `UPDATE app_users SET status=$2, updated_at=NOW() WHERE id=$1::uuid`, userID, request.Status); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user not found"})
		return
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM user_roles WHERE user_id=$1::uuid`, userID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user roles could not be updated"})
		return
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO user_roles (user_id, role_name) VALUES ($1::uuid,$2)`, userID, request.Role); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user not found"})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user update unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) adminGroupAccess(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.listAdminGroupAccess(w, r)
		return
	}
	if r.Method == http.MethodPut {
		a.setAdminGroupAccess(w, r)
		return
	}
	w.Header().Set("allow", "GET, PUT")
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func (a *app) listAdminGroupAccess(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userId is required"})
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT g.id, g.subject, g.platform, g.chat_type, g.parent_group_id, g.topic_id, g.is_selected,
		       COALESCE(uga.can_read,FALSE), COALESCE(uga.can_manage,FALSE)
		FROM wa_groups g
		LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid
		ORDER BY g.platform, COALESCE(g.parent_group_id,g.id), CASE WHEN g.chat_type='topic' THEN 1 ELSE 0 END, g.subject`, userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "group access unavailable"})
		return
	}
	defer rows.Close()
	result := make([]adminGroupAccessView, 0)
	for rows.Next() {
		var item adminGroupAccessView
		if err := rows.Scan(&item.GroupID, &item.Subject, &item.Platform, &item.ChatType, &item.ParentGroupID, &item.TopicID, &item.IsSelected, &item.CanRead, &item.CanManage); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "group access unavailable"})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *app) setAdminGroupAccess(w http.ResponseWriter, r *http.Request) {
	var request groupPermissionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.UserID == "" || request.GroupID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userId and groupId are required"})
		return
	}
	if !request.CanRead {
		request.CanManage = false
	}
	_, err := a.db.Exec(r.Context(), `
		INSERT INTO user_group_access (user_id, group_id, can_read, can_manage)
		VALUES ($1::uuid,$2,$3,$4)
		ON CONFLICT (user_id,group_id) DO UPDATE SET can_read=EXCLUDED.can_read, can_manage=EXCLUDED.can_manage`, request.UserID, request.GroupID, request.CanRead, request.CanManage)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "group access could not be saved"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
