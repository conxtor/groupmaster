package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "wagi_session"

type authenticatedUser struct {
	ID    string   `json:"id"`
	Email string   `json:"email"`
	Name  string   `json:"name"`
	Roles []string `json:"roles"`
}

func (u authenticatedUser) isAdmin() bool {
	for _, role := range u.Roles {
		if role == "admin" {
			return true
		}
	}
	return false
}

// groupReadCondition returns a SQL predicate that scopes a query to groups
// visible to the current user. Administrators retain the existing global MVP
// view, while regular users require an explicit user_group_access grant.
func groupReadCondition(user *authenticatedUser, alias string, args *[]any) string {
	if user.isAdmin() {
		return "TRUE"
	}
	*args = append(*args, user.ID)
	return fmt.Sprintf("EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.user_id=$%d::uuid AND uga.group_id=%s.id AND uga.can_read=TRUE)", len(*args), alias)
}

func groupManageCondition(user *authenticatedUser, alias string, args *[]any) string {
	if user.isAdmin() {
		return "TRUE"
	}
	*args = append(*args, user.ID)
	return fmt.Sprintf("EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.user_id=$%d::uuid AND uga.group_id=%s.id AND uga.can_manage=TRUE)", len(*args), alias)
}

// groupSelectedCondition keeps the legacy administrator selection while
// storing each regular user's subscription independently.
func groupSelectedCondition(user *authenticatedUser, alias string, args *[]any) string {
	if user.isAdmin() {
		return fmt.Sprintf("%s.is_selected = TRUE", alias)
	}
	*args = append(*args, user.ID)
	return fmt.Sprintf("EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.user_id=$%d::uuid AND uga.group_id=%s.id AND uga.can_read=TRUE AND uga.is_selected=TRUE)", len(*args), alias)
}

type authRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type roleRequest struct {
	Role   string `json:"role"`
	Status string `json:"status"`
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func (a *app) bootstrapAdmin() error {
	email := normalizeEmail(env("WAGI_BOOTSTRAP_ADMIN_EMAIL", "volker@kerkhoff.es"))
	name := strings.TrimSpace(env("WAGI_BOOTSTRAP_ADMIN_NAME", "Volker Kerkhoff"))
	password := env("WAGI_BOOTSTRAP_ADMIN_PASSWORD", "Ctas2025!")
	if email == "" || name == "" || password == "" {
		return errors.New("bootstrap admin configuration is incomplete")
	}
	var userID string
	err := a.db.QueryRow(
		context.Background(),
		`SELECT id::text FROM app_users WHERE LOWER(email)=LOWER($1)`, email,
	).Scan(&userID)
	if err == nil {
		_, updateErr := a.db.Exec(context.Background(), `
			INSERT INTO user_roles (user_id, role_name) VALUES ($1::uuid, 'admin') ON CONFLICT DO NOTHING`, userID)
		return updateErr
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	return a.db.QueryRow(context.Background(), `
		WITH created AS (
			INSERT INTO app_users (email, name, password_hash)
			VALUES ($1, $2, $3)
			RETURNING id
		)
		INSERT INTO user_roles (user_id, role_name)
		SELECT id, 'admin' FROM created
		RETURNING user_id`, email, name, string(hash)).Scan(&userID)
}

func (a *app) userFromRequest(r *http.Request) (*authenticatedUser, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return nil, errors.New("not authenticated")
	}
	user := &authenticatedUser{}
	roles := []string{}
	err = a.db.QueryRow(r.Context(), `
		SELECT u.id::text, u.email, u.name, COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}')
		FROM user_sessions s
		JOIN app_users u ON u.id=s.user_id
		LEFT JOIN user_roles ur ON ur.user_id=u.id
		WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.status='active'
		GROUP BY u.id, u.email, u.name`, hashToken(cookie.Value)).Scan(&user.ID, &user.Email, &user.Name, &roles)
	if err != nil {
		return nil, errors.New("not authenticated")
	}
	user.Roles = roles
	_, _ = a.db.Exec(r.Context(), `UPDATE user_sessions SET last_seen_at=NOW() WHERE token_hash=$1`, hashToken(cookie.Value))
	return user, nil
}

func (a *app) issueSession(w http.ResponseWriter, r *http.Request, user authenticatedUser) error {
	token, err := randomToken()
	if err != nil {
		return err
	}
	_, err = a.db.Exec(r.Context(), `
		INSERT INTO user_sessions (user_id, token_hash, expires_at, user_agent, remote_addr)
		VALUES ($1::uuid,$2,NOW()+INTERVAL '30 days',$3,$4)`, user.ID, hashToken(token), r.UserAgent(), r.RemoteAddr)
	if err != nil {
		return err
	}
	secure := strings.EqualFold(env("WAGI_COOKIE_SECURE", "false"), "true")
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", MaxAge: 30 * 24 * 60 * 60, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
	return nil
}

func (a *app) clearSession(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		_, _ = a.db.Exec(r.Context(), `DELETE FROM user_sessions WHERE token_hash=$1`, hashToken(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (a *app) authMe(w http.ResponseWriter, r *http.Request) {
	user, err := a.userFromRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (a *app) authLogin(w http.ResponseWriter, r *http.Request) {
	var request authRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	email := normalizeEmail(request.Email)
	var user authenticatedUser
	var passwordHash string
	var roles []string
	err := a.db.QueryRow(r.Context(), `
		SELECT u.id::text, u.email, u.name, u.password_hash, COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}')
		FROM app_users u LEFT JOIN user_roles ur ON ur.user_id=u.id
		WHERE LOWER(u.email)=LOWER($1) AND u.status='active'
		GROUP BY u.id, u.email, u.name, u.password_hash`, email).Scan(&user.ID, &user.Email, &user.Name, &passwordHash, &roles)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(request.Password)) != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	user.Roles = roles
	if err := a.issueSession(w, r, user); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session could not be created"})
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (a *app) authLogout(w http.ResponseWriter, r *http.Request) {
	a.clearSession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) authRegister(w http.ResponseWriter, r *http.Request) {
	var request authRequest
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
	hash, err := bcrypt.GenerateFromPassword([]byte(request.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be prepared"})
		return
	}
	var userID string
	err = a.db.QueryRow(r.Context(), `INSERT INTO app_users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING id::text`, email, name, string(hash)).Scan(&userID)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "account could not be created"})
		return
	}
	_, _ = a.db.Exec(r.Context(), `INSERT INTO user_roles (user_id, role_name) VALUES ($1::uuid,'user')`, userID)
	user := authenticatedUser{ID: userID, Email: email, Name: name, Roles: []string{"user"}}
	if err := a.issueSession(w, r, user); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session could not be created"})
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (a *app) requireUser(w http.ResponseWriter, r *http.Request) (*authenticatedUser, bool) {
	user, err := a.userFromRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return nil, false
	}
	return user, true
}

func requireAuthenticated(a *app, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.requireUser(w, r); !ok {
			return
		}
		handler(w, r)
	}
}

func requireAdmin(a *app, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := a.requireUser(w, r)
		if !ok {
			return
		}
		if !user.isAdmin() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "administrator role required"})
			return
		}
		handler(w, r)
	}
}
