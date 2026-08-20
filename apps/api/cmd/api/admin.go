package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type adminUserView struct {
	ID              string     `json:"id"`
	Email           string     `json:"email"`
	Name            string     `json:"name"`
	Status          string     `json:"status"`
	Roles           []string   `json:"roles"`
	CreatedAt       time.Time  `json:"createdAt"`
	LastConnectedAt *time.Time `json:"lastConnectedAt,omitempty"`
}

type adminCreateUserRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Status   string `json:"status"`
	Locale   string `json:"locale"`
}

func (a *app) adminUsers(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/users")
	if path == "" || path == "/" {
		if r.Method == http.MethodPost {
			a.createAdminUser(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("allow", http.MethodGet+", "+http.MethodPost)
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

// listAdminUsers lists all accounts and their current roles/status.
// @Summary List users
// @Tags administration
// @Produce json
// @Security CookieAuth
// @Success 200 {array} adminUserView
// @Failure 403 {object} map[string]string
// @Router /admin/users [get]
func (a *app) listAdminUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT u.id::text, u.email, u.name, u.status,
		       COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}'), u.created_at,
		       MAX(s.last_seen_at)
		FROM app_users u LEFT JOIN user_roles ur ON ur.user_id=u.id
		LEFT JOIN user_sessions s ON s.user_id=u.id
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
		if err := rows.Scan(&item.ID, &item.Email, &item.Name, &item.Status, &item.Roles, &item.CreatedAt, &item.LastConnectedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "users unavailable"})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, http.StatusOK, result)
}

// createAdminUser creates an administrator-managed, already verified account.
// @Summary Create user
// @Tags administration
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body adminCreateUserRequest true "User data"
// @Success 201 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Router /admin/users [post]
func (a *app) createAdminUser(w http.ResponseWriter, r *http.Request) {
	var request adminCreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	email := normalizeEmail(request.Email)
	name := strings.TrimSpace(request.Name)
	if !strings.Contains(email, "@") || len(name) < 2 || len(request.Password) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email, name and a password of at least 10 characters are required"})
		return
	}
	if request.Role == "" {
		request.Role = "user"
	}
	if request.Status == "" {
		request.Status = "active"
	}
	if (request.Role != "admin" && request.Role != "user") || (request.Status != "active" && request.Status != "disabled") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role or status is invalid"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(request.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be prepared"})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user creation unavailable"})
		return
	}
	defer tx.Rollback(r.Context())
	var userID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO app_users (email,name,password_hash,status,preferred_locale,email_verified_at)
		VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id::text`, email, name, string(hash), request.Status, normalizeAuthLocale(request.Locale)).Scan(&userID)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user could not be created"})
		}
		return
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO user_roles (user_id,role_name) VALUES ($1::uuid,$2)`, userID, request.Role); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user role could not be created"})
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user creation unavailable"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": userID, "email": email, "name": name, "role": request.Role, "status": request.Status})
}

// updateAdminUser changes a user's role and status.
// @Summary Update user role/status
// @Tags administration
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param id path string true "User UUID"
// @Param body body roleRequest true "Role and status"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /admin/users/{id} [patch]
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
