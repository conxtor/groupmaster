package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"html"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// emailService is intentionally small and provider-neutral. Mailcow and most
// hosted providers expose either SMTP with STARTTLS on 587 or implicit TLS on
// 465, both of which are supported here without adding a third-party SDK.
type emailService struct {
	enabled       bool
	host          string
	port          int
	username      string
	password      string
	useTLS        bool
	useSSL        bool
	fromEmail     string
	fromName      string
	replyTo       string
	publicURL     string
	verificationH time.Duration
	resetH        time.Duration
}

func normalizeAuthLocale(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "_", "-")))
	if value == "" {
		return "de"
	}
	switch strings.Split(value, "-")[0] {
	case "de", "es", "ca", "en", "fr":
		return strings.Split(value, "-")[0]
	default:
		return "de"
	}
}

func newEmailService() *emailService {
	port := 587
	if value, err := strconv.Atoi(env("SMTP_PORT", "587")); err == nil && value > 0 {
		port = value
	}
	return &emailService{
		enabled:       strings.EqualFold(env("SMTP_ENABLED", "false"), "true"),
		host:          strings.TrimSpace(env("SMTP_HOST", "")),
		port:          port,
		username:      env("SMTP_USERNAME", ""),
		password:      env("SMTP_PASSWORD", ""),
		useTLS:        strings.EqualFold(env("SMTP_USE_TLS", "true"), "true"),
		useSSL:        strings.EqualFold(env("SMTP_USE_SSL", "false"), "true"),
		fromEmail:     strings.TrimSpace(env("SMTP_FROM_EMAIL", "")),
		fromName:      strings.TrimSpace(env("SMTP_FROM_NAME", "WAGI")),
		replyTo:       strings.TrimSpace(env("SMTP_REPLY_TO", "")),
		publicURL:     strings.TrimRight(strings.TrimSpace(env("WAGI_PUBLIC_URL", "http://localhost:3000")), "/"),
		verificationH: time.Duration(envInt("EMAIL_VERIFICATION_HOURS", 48)) * time.Hour,
		resetH:        time.Duration(envInt("PASSWORD_RESET_HOURS", 1)) * time.Hour,
	}
}

func (s *emailService) configured() bool {
	return s.enabled && s.host != "" && s.fromEmail != ""
}

func sanitizeHeader(value string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(strings.TrimSpace(value))
}

func (s *emailService) send(ctx context.Context, recipient, subject, body string) error {
	if !s.configured() {
		return errors.New("SMTP email delivery is not configured")
	}
	recipient = sanitizeHeader(recipient)
	if recipient == "" {
		return errors.New("email recipient is empty")
	}

	address := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var connection net.Conn
	var err error
	if s.useSSL {
		connection, err = tls.DialWithDialer(dialer, "tcp", address, &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12})
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return fmt.Errorf("SMTP connection failed: %w", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(30 * time.Second))

	client, err := smtp.NewClient(connection, s.host)
	if err != nil {
		return fmt.Errorf("SMTP client initialization failed: %w", err)
	}
	defer client.Close()

	if !s.useSSL && s.useTLS {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return errors.New("SMTP server does not advertise STARTTLS")
		}
		if err := client.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("SMTP STARTTLS failed: %w", err)
		}
	}
	if s.username != "" {
		if err := client.Auth(smtp.PlainAuth("", s.username, s.password, s.host)); err != nil {
			return fmt.Errorf("SMTP authentication failed: %w", err)
		}
	}

	from := sanitizeHeader(s.fromEmail)
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("SMTP MAIL FROM failed: %w", err)
	}
	if err := client.Rcpt(recipient); err != nil {
		return fmt.Errorf("SMTP recipient rejected: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA failed: %w", err)
	}
	fromHeader := from
	if s.fromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", sanitizeHeader(s.fromName), from)
	}
	message := strings.Builder{}
	fmt.Fprintf(&message, "From: %s\r\n", fromHeader)
	fmt.Fprintf(&message, "To: %s\r\n", recipient)
	fmt.Fprintf(&message, "Subject: %s\r\n", sanitizeHeader(subject))
	fmt.Fprintf(&message, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	if s.replyTo != "" {
		fmt.Fprintf(&message, "Reply-To: %s\r\n", sanitizeHeader(s.replyTo))
	}
	message.WriteString("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	message.WriteString(body)
	message.WriteString("\r\n")
	if _, err := writer.Write([]byte(message.String())); err != nil {
		_ = writer.Close()
		return fmt.Errorf("SMTP message write failed: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("SMTP message close failed: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("SMTP QUIT failed: %w", err)
	}
	return nil
}

func localizedAuthEmail(locale, purpose, name, link string) (string, string) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "WAGI"
	}
	link = html.UnescapeString(link)
	type copy struct{ subject, intro, action, expiry, footer string }
	texts := map[string]map[string]copy{
		"de": {
			"email_verification": {"E-Mail-Adresse bestätigen", "Hallo " + name + ",\n\nbitte bestätige deine E-Mail-Adresse, um dein WAGI-Konto zu aktivieren:", "E-Mail-Adresse bestätigen", "Der Link ist 48 Stunden gültig.", "Wenn du dieses Konto nicht erstellt hast, kannst du diese Nachricht ignorieren."},
			"password_reset":     {"WAGI-Passwort zurücksetzen", "Hallo " + name + ",\n\nüber diesen Link kannst du ein neues Passwort für dein WAGI-Konto setzen:", "Passwort zurücksetzen", "Der Link ist eine Stunde gültig.", "Wenn du keine Zurücksetzung angefordert hast, kannst du diese Nachricht ignorieren."},
		},
		"es": {
			"email_verification": {"Confirma tu dirección de correo", "Hola " + name + ",\n\nconfirma tu dirección de correo para activar tu cuenta de WAGI:", "Confirmar dirección de correo", "El enlace es válido durante 48 horas.", "Si no has creado esta cuenta, puedes ignorar este mensaje."},
			"password_reset":     {"Restablecer la contraseña de WAGI", "Hola " + name + ",\n\nutiliza este enlace para establecer una nueva contraseña para tu cuenta de WAGI:", "Restablecer contraseña", "El enlace es válido durante una hora.", "Si no has solicitado este cambio, puedes ignorar este mensaje."},
		},
		"ca": {
			"email_verification": {"Confirma la teva adreça electrònica", "Hola " + name + ",\n\nconfirma la teva adreça electrònica per activar el teu compte de WAGI:", "Confirmar l'adreça electrònica", "L'enllaç és vàlid durant 48 hores.", "Si no has creat aquest compte, pots ignorar aquest missatge."},
			"password_reset":     {"Restableix la contrasenya de WAGI", "Hola " + name + ",\n\nutilitza aquest enllaç per establir una contrasenya nova per al teu compte de WAGI:", "Restablir la contrasenya", "L'enllaç és vàlid durant una hora.", "Si no has sol·licitat aquest canvi, pots ignorar aquest missatge."},
		},
		"en": {
			"email_verification": {"Confirm your email address", "Hello " + name + ",\n\nconfirm your email address to activate your WAGI account:", "Confirm email address", "This link is valid for 48 hours.", "If you did not create this account, you can ignore this message."},
			"password_reset":     {"Reset your WAGI password", "Hello " + name + ",\n\nuse this link to set a new password for your WAGI account:", "Reset password", "This link is valid for one hour.", "If you did not request a reset, you can ignore this message."},
		},
		"fr": {
			"email_verification": {"Confirmez votre adresse e-mail", "Bonjour " + name + ",\n\nconfirmez votre adresse e-mail pour activer votre compte WAGI :", "Confirmer l'adresse e-mail", "Ce lien est valable pendant 48 heures.", "Si vous n'avez pas créé ce compte, vous pouvez ignorer ce message."},
			"password_reset":     {"Réinitialiser votre mot de passe WAGI", "Bonjour " + name + ",\n\nutilisez ce lien pour définir un nouveau mot de passe pour votre compte WAGI :", "Réinitialiser le mot de passe", "Ce lien est valable pendant une heure.", "Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer ce message."},
		},
	}
	selected, ok := texts[normalizeAuthLocale(locale)]
	if !ok {
		selected = texts["de"]
	}
	content, ok := selected[purpose]
	if !ok {
		content = selected["email_verification"]
	}
	return content.subject, fmt.Sprintf("%s\n\n%s\n%s\n\n%s\n\n%s", content.intro, content.action, link, content.expiry, content.footer)
}
