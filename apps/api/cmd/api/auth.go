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
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "wagi_session"

type authenticatedUser struct {
	ID              string   `json:"id"`
	Email           string   `json:"email"`
	Name            string   `json:"name"`
	PreferredLocale string   `json:"preferredLocale"`
	Roles           []string `json:"roles"`
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
	Locale   string `json:"locale"`
}

type authTokenRequest struct {
	Token string `json:"token"`
}

type passwordResetRequest struct {
	Email  string `json:"email"`
	Locale string `json:"locale"`
}

type passwordResetConfirmRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
}

type profileUpdateRequest struct {
	Name            string `json:"name"`
	Email           string `json:"email"`
	Locale          string `json:"locale"`
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
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
			UPDATE app_users
			SET email_verified_at=COALESCE(email_verified_at,NOW()), preferred_locale=COALESCE(NULLIF(preferred_locale,''),'de'), updated_at=NOW()
			WHERE id=$1::uuid`, userID)
		if updateErr != nil {
			return updateErr
		}
		_, updateErr = a.db.Exec(context.Background(), `
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
			INSERT INTO app_users (email, name, password_hash, preferred_locale, email_verified_at)
			VALUES ($1, $2, $3, 'de', NOW())
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
		SELECT u.id::text, u.email, u.name, COALESCE(u.preferred_locale,'de'), COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}')
		FROM user_sessions s
		JOIN app_users u ON u.id=s.user_id
		LEFT JOIN user_roles ur ON ur.user_id=u.id
		WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.status='active'
		GROUP BY u.id, u.email, u.name, u.preferred_locale`, hashToken(cookie.Value)).Scan(&user.ID, &user.Email, &user.Name, &user.PreferredLocale, &roles)
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
		// Keep the row so administration can show the last connection even
		// after an explicit logout. Expired rows are not accepted for auth.
		_, _ = a.db.Exec(r.Context(), `UPDATE user_sessions SET expires_at=NOW() WHERE token_hash=$1`, hashToken(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

// authMe returns the current session user.
// @Summary Get current user
// @Tags authentication
// @Produce json
// @Security CookieAuth
// @Success 200 {object} authenticatedUser
// @Failure 401 {object} map[string]string
// @Router /auth/me [get]
func (a *app) authMe(w http.ResponseWriter, r *http.Request) {
	user, err := a.userFromRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// authProfile updates the current user's profile, locale, or password.
// @Summary Update profile
// @Tags authentication
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body profileUpdateRequest true "Profile changes"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Router /auth/profile [patch]
func (a *app) authProfile(w http.ResponseWriter, r *http.Request) {
	user, err := a.userFromRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return
	}
	if r.Method != http.MethodPatch {
		w.Header().Set("allow", http.MethodPatch)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var request profileUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	name := strings.TrimSpace(request.Name)
	if len(name) < 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name must contain at least 2 characters"})
		return
	}
	email := normalizeEmail(request.Email)
	if email == "" {
		email = user.Email
	}
	if !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email is invalid"})
		return
	}
	newPassword := request.NewPassword
	passwordChanged := newPassword != ""
	emailChanged := email != user.Email
	if passwordChanged && len(newPassword) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password must contain at least 10 characters"})
		return
	}
	if (passwordChanged || emailChanged) && request.CurrentPassword == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current password is required for this change"})
		return
	}
	var currentHash string
	if passwordChanged || emailChanged {
		if err := a.db.QueryRow(r.Context(), `SELECT password_hash FROM app_users WHERE id=$1::uuid`, user.ID).Scan(&currentHash); err != nil || bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(request.CurrentPassword)) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current password is incorrect"})
			return
		}
	}
	if emailChanged && (a.email == nil || !a.email.configured()) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "email delivery must be configured before changing the email address"})
		return
	}
	if emailChanged {
		var exists bool
		if err := a.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM app_users WHERE LOWER(email)=LOWER($1) AND id<>$2::uuid)`, email, user.ID).Scan(&exists); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile update unavailable"})
			return
		}
		if exists {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
			return
		}
	}
	locale := normalizeAuthLocale(request.Locale)
	if request.Locale == "" {
		locale = normalizeAuthLocale(user.PreferredLocale)
	}
	var passwordHash any
	if passwordChanged {
		hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be prepared"})
			return
		}
		passwordHash = string(hash)
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile update unavailable"})
		return
	}
	defer tx.Rollback(r.Context())
	if passwordChanged {
		if _, err = tx.Exec(r.Context(), `UPDATE app_users SET name=$2,email=$3,preferred_locale=$4,password_hash=$5,email_verified_at=CASE WHEN $3<>$6 THEN NULL ELSE email_verified_at END,updated_at=NOW() WHERE id=$1::uuid`, user.ID, name, email, locale, passwordHash, user.Email); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile could not be updated"})
			return
		}
	} else if _, err = tx.Exec(r.Context(), `UPDATE app_users SET name=$2,email=$3,preferred_locale=$4,email_verified_at=CASE WHEN $3<>$5 THEN NULL ELSE email_verified_at END,updated_at=NOW() WHERE id=$1::uuid`, user.ID, name, email, locale, user.Email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile could not be updated"})
		return
	}
	if emailChanged {
		if _, err = tx.Exec(r.Context(), `DELETE FROM auth_email_tokens WHERE user_id=$1::uuid AND purpose='email_verification'`, user.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile could not be updated"})
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "profile update unavailable"})
		return
	}
	if emailChanged {
		if err := a.sendAuthEmail(r.Context(), user.ID, email, name, locale, "email_verification"); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "verification email could not be sent"})
			return
		}
		a.clearSession(w, r)
	} else if passwordChanged {
		_, _ = a.db.Exec(r.Context(), `UPDATE user_sessions SET expires_at=NOW() WHERE user_id=$1::uuid`, user.ID)
		a.clearSession(w, r)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "email": email, "name": name, "locale": locale, "verificationRequired": emailChanged, "sessionRevoked": emailChanged || passwordChanged})
}

// authLogin authenticates a user and sets the session cookie.
// @Summary Log in
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body authRequest true "Login credentials"
// @Success 200 {object} authenticatedUser
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Router /auth/login [post]
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
	var emailVerified bool
	err := a.db.QueryRow(r.Context(), `
		SELECT u.id::text, u.email, u.name, COALESCE(u.preferred_locale,'de'), u.email_verified_at IS NOT NULL, u.password_hash, COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}')
		FROM app_users u LEFT JOIN user_roles ur ON ur.user_id=u.id
		WHERE LOWER(u.email)=LOWER($1) AND u.status='active'
		GROUP BY u.id, u.email, u.name, u.preferred_locale, u.email_verified_at, u.password_hash`, email).Scan(&user.ID, &user.Email, &user.Name, &user.PreferredLocale, &emailVerified, &passwordHash, &roles)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(request.Password)) != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials", "code": "invalid_credentials"})
		return
	}
	if !emailVerified {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "email verification required", "code": "email_verification_required"})
		return
	}
	if locale := normalizeAuthLocale(request.Locale); request.Locale != "" {
		user.PreferredLocale = locale
		_, _ = a.db.Exec(r.Context(), `UPDATE app_users SET preferred_locale=$2, updated_at=NOW() WHERE id=$1::uuid`, user.ID, locale)
	}
	user.Roles = roles
	if err := a.issueSession(w, r, user); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session could not be created"})
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// authLogout invalidates the current session cookie.
// @Summary Log out
// @Tags authentication
// @Produce json
// @Security CookieAuth
// @Success 200 {object} map[string]bool
// @Router /auth/logout [post]
func (a *app) authLogout(w http.ResponseWriter, r *http.Request) {
	a.clearSession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// authRegister creates a user pending email verification.
// @Summary Register account
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body authRequest true "Registration data"
// @Success 202 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Router /auth/register [post]
func (a *app) authRegister(w http.ResponseWriter, r *http.Request) {
	var request authRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	email := normalizeEmail(request.Email)
	name := strings.TrimSpace(request.Name)
	if !strings.Contains(email, "@") || len(name) < 2 || len(request.Password) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email, name and a password of at least 10 characters are required", "code": "invalid_registration"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(request.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be prepared"})
		return
	}
	var userID string
	locale := normalizeAuthLocale(request.Locale)
	err = a.db.QueryRow(r.Context(), `INSERT INTO app_users (email,name,password_hash,preferred_locale) VALUES ($1,$2,$3,$4) RETURNING id::text`, email, name, string(hash), locale).Scan(&userID)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered", "code": "email_already_registered"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "account could not be created"})
		return
	}
	_, _ = a.db.Exec(r.Context(), `INSERT INTO user_roles (user_id, role_name) VALUES ($1::uuid,'user')`, userID)
	if err := a.sendAuthEmail(r.Context(), userID, email, name, locale, "email_verification"); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "verification email could not be sent", "code": "email_delivery_unavailable"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "verification_required", "email": email, "locale": locale})
}

func requirePOST(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodPost {
		return true
	}
	w.Header().Set("allow", http.MethodPost)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return false
}

func (a *app) sendAuthEmail(ctx context.Context, userID, recipient, name, locale, purpose string) error {
	if a.email == nil || !a.email.configured() {
		return errors.New("email service is not configured")
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	duration := a.email.verificationH
	path := "/verify-email?token=" + token
	if purpose == "password_reset" {
		duration = a.email.resetH
		path = "/password-reset/confirm?token=" + token
	}
	if duration <= 0 {
		duration = 1 * time.Hour
	}
	_, err = a.db.Exec(ctx, `DELETE FROM auth_email_tokens WHERE user_id=$1::uuid AND purpose=$2`, userID, purpose)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `INSERT INTO auth_email_tokens (user_id,purpose,token_hash,locale,expires_at) VALUES ($1::uuid,$2,$3,$4,NOW()+$5::interval)`, userID, purpose, hashToken(token), normalizeAuthLocale(locale), fmt.Sprintf("%d seconds", int(duration.Seconds())))
	if err != nil {
		return err
	}
	subject, body := localizedAuthEmail(locale, purpose, name, a.email.publicURL+path)
	emailCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return a.email.send(emailCtx, recipient, subject, body)
}

// authVerifyEmail activates a user with a valid verification token.
// @Summary Verify email
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body authTokenRequest true "Verification token"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Router /auth/verify-email [post]
func (a *app) authVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var request authTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.Token) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid verification token", "code": "invalid_token"})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification could not be completed"})
		return
	}
	defer tx.Rollback(r.Context())
	var userID string
	err = tx.QueryRow(r.Context(), `SELECT user_id::text FROM auth_email_tokens WHERE token_hash=$1 AND purpose='email_verification' AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`, hashToken(request.Token)).Scan(&userID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "verification link is invalid or expired", "code": "invalid_token"})
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE app_users SET email_verified_at=NOW(), updated_at=NOW() WHERE id=$1::uuid`, userID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification could not be completed"})
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE auth_email_tokens SET used_at=NOW() WHERE token_hash=$1`, hashToken(request.Token)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification could not be completed"})
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification could not be completed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"verified": true})
}

// authResendVerification sends a new verification email without revealing account existence.
// @Summary Resend verification email
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body passwordResetRequest true "Email and locale"
// @Success 202 {object} map[string]string
// @Router /auth/email-verification/resend [post]
func (a *app) authResendVerification(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var request passwordResetRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	var userID, name string
	var verified bool
	locale := normalizeAuthLocale(request.Locale)
	err := a.db.QueryRow(r.Context(), `SELECT id::text,name,email_verified_at IS NOT NULL,COALESCE(preferred_locale,'de') FROM app_users WHERE LOWER(email)=LOWER($1) AND status='active'`, normalizeEmail(request.Email)).Scan(&userID, &name, &verified, &locale)
	if err == nil && !verified {
		if request.Locale != "" {
			locale = normalizeAuthLocale(request.Locale)
		}
		_ = a.sendAuthEmail(r.Context(), userID, normalizeEmail(request.Email), name, locale, "email_verification")
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "if_account_exists_email_sent"})
}

// authRequestPasswordReset requests a localized password-reset email.
// @Summary Request password reset
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body passwordResetRequest true "Reset request"
// @Success 202 {object} map[string]string
// @Router /auth/password-reset/request [post]
func (a *app) authRequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var request passwordResetRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	email := normalizeEmail(request.Email)
	var userID, name, preferredLocale string
	var verified bool
	err := a.db.QueryRow(r.Context(), `SELECT id::text,name,COALESCE(preferred_locale,'de'),email_verified_at IS NOT NULL FROM app_users WHERE LOWER(email)=LOWER($1) AND status='active'`, email).Scan(&userID, &name, &preferredLocale, &verified)
	if err == nil && verified {
		locale := normalizeAuthLocale(preferredLocale)
		if request.Locale != "" {
			locale = normalizeAuthLocale(request.Locale)
		}
		_ = a.sendAuthEmail(r.Context(), userID, email, name, locale, "password_reset")
	}
	// Always return the same response so the endpoint does not disclose whether
	// an address is registered.
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "if_account_exists_email_sent"})
}

// authConfirmPasswordReset changes a password using a valid reset token.
// @Summary Confirm password reset
// @Tags authentication
// @Accept json
// @Produce json
// @Param body body passwordResetConfirmRequest true "Reset confirmation"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Router /auth/password-reset/confirm [post]
func (a *app) authConfirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !requirePOST(w, r) {
		return
	}
	var request passwordResetConfirmRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.Token) == "" || len(request.NewPassword) < 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid token and a password of at least 10 characters are required", "code": "invalid_reset_request"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(request.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be prepared"})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be reset"})
		return
	}
	defer tx.Rollback(r.Context())
	var userID string
	err = tx.QueryRow(r.Context(), `SELECT user_id::text FROM auth_email_tokens WHERE token_hash=$1 AND purpose='password_reset' AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`, hashToken(request.Token)).Scan(&userID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "reset link is invalid or expired", "code": "invalid_token"})
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE app_users SET password_hash=$2, updated_at=NOW() WHERE id=$1::uuid`, userID, string(hash)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be reset"})
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE auth_email_tokens SET used_at=NOW() WHERE token_hash=$1`, hashToken(request.Token)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be reset"})
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE user_sessions SET expires_at=NOW() WHERE user_id=$1::uuid`, userID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be reset"})
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password could not be reset"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
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
