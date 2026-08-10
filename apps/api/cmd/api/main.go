package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

type app struct {
	db *pgxpool.Pool
	nc *nats.Conn
	js nats.JetStreamContext
}

type group struct {
	ID               string    `json:"id"`
	Subject          string    `json:"subject"`
	ParticipantCount int       `json:"participantCount"`
	IsSelected       bool      `json:"isSelected"`
	DiscoveredAt     time.Time `json:"discoveredAt"`
}

type message struct {
	ID           string          `json:"id"`
	GroupID      string          `json:"groupId"`
	GroupSubject string          `json:"groupSubject"`
	SenderJID    string          `json:"senderJid"`
	SenderName   *string         `json:"senderName,omitempty"`
	Kind         string          `json:"kind"`
	Text         *string         `json:"text,omitempty"`
	ReplyToWAID  *string         `json:"replyToWaMessageId,omitempty"`
	Platform     string          `json:"platform"`
	ImageURL     string          `json:"imageUrl,omitempty"`
	ReceivedAt   time.Time       `json:"receivedAt"`
	HasMedia     bool            `json:"hasMedia"`
	Analysis     json.RawMessage `json:"analysis,omitempty"`
}

type audioJobRequest struct {
	MessageID string `json:"messageId"`
	MediaKey  string `json:"mediaKey"`
	MediaMime string `json:"mediaMime"`
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func ensureEventStream(js nats.JetStreamContext) error {
	if _, err := js.StreamInfo("WAGI_EVENTS"); err == nil {
		return nil
	}
	_, err := js.AddStream(&nats.StreamConfig{
		Name:     "WAGI_EVENTS",
		Subjects: []string{"wa.>", "media.>", "ai.>"},
		Storage:  nats.FileStorage,
		MaxMsgs:  -1,
	})
	if err != nil {
		if _, infoErr := js.StreamInfo("WAGI_EVENTS"); infoErr == nil {
			return nil
		}
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("access-control-allow-origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *app) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "api"})
}

func (a *app) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database-unavailable"})
		return
	}
	if a.nc == nil || a.nc.IsClosed() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "nats-unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *app) groups(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `SELECT id, subject, participant_count, is_selected, discovered_at FROM wa_groups ORDER BY subject`)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	result := make([]group, 0)
	for rows.Next() {
		var item group
		if err := rows.Scan(&item.ID, &item.Subject, &item.ParticipantCount, &item.IsSelected, &item.DiscoveredAt); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, 200, result)
}

func (a *app) messages(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		}
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT m.id, m.group_id, g.subject, m.sender_jid, m.sender_name, m.kind, m.text,
		       COALESCE(NULLIF(m.raw #>> '{message,extendedTextMessage,contextInfo,stanzaId}', ''),
		                CASE WHEN m.raw ? 'reply_to_message' THEN m.group_id || ':' || (m.raw #>> '{reply_to_message,message_id}') END),
		       CASE WHEN m.group_id LIKE 'tg:%' THEN 'telegram' ELSE 'whatsapp' END,
		       m.received_at, m.has_media,
		       COALESCE(jsonb_build_object('relevant', a.relevant, 'score', a.relevance_score, 'summary', a.summary, 'facts', a.facts, 'entities', a.entities, 'events', a.events, 'places', a.places, 'model', a.model), '{}'::jsonb)
		FROM messages m JOIN wa_groups g ON g.id = m.group_id
		LEFT JOIN message_analyses a ON a.message_id = m.id
		WHERE g.is_selected = TRUE ORDER BY m.received_at DESC LIMIT $1`, limit)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	result := make([]message, 0)
	for rows.Next() {
		var item message
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupSubject, &item.SenderJID, &item.SenderName, &item.Kind, &item.Text, &item.ReplyToWAID, &item.Platform, &item.ReceivedAt, &item.HasMedia, &item.Analysis); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		item.ImageURL = mockImageURL(item.GroupID, item.Text)
		result = append(result, item)
	}
	writeJSON(w, 200, result)
}

func mockImageURL(groupID string, text *string) string {
	if !strings.HasPrefix(groupID, "120363mock") || text == nil {
		return ""
	}
	normalized := strings.ToLower(*text)
	switch {
	case strings.Contains(normalized, "routenkarte"):
		return "/mock/barcelona-route.svg"
	case strings.Contains(normalized, "picknick"):
		return "/mock/picknick.svg"
	case strings.Contains(normalized, "strand") || strings.Contains(normalized, "schwimm"):
		return "/mock/costa-brava-beach.svg"
	case strings.Contains(normalized, "dashboard"):
		return "/mock/remote-dashboard.svg"
	case strings.Contains(normalized, "offsite"):
		return "/mock/remote-offsite.svg"
	default:
		return ""
	}
}

func (a *app) selectGroup(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimPrefix(r.URL.Path, "/api/v1/groups/")
	groupID = strings.TrimSuffix(groupID, "/select")
	var body struct {
		Selected bool `json:"selected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	var item group
	err := a.db.QueryRow(r.Context(), `UPDATE wa_groups SET is_selected = $1, updated_at = NOW() WHERE id = $2 RETURNING id, subject, participant_count, is_selected, discovered_at`, body.Selected, groupID).Scan(&item.ID, &item.Subject, &item.ParticipantCount, &item.IsSelected, &item.DiscoveredAt)
	if err == pgx.ErrNoRows {
		writeJSON(w, 404, map[string]string{"error": "group not found"})
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, item)
}

func (a *app) audioJob(w http.ResponseWriter, r *http.Request) {
	var request audioJobRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.MessageID == "" || request.MediaKey == "" {
		writeJSON(w, 400, map[string]string{"error": "messageId and mediaKey are required"})
		return
	}
	jobID := uuid.New()
	_, err := a.db.Exec(r.Context(), `INSERT INTO audio_jobs (id, message_id, media_key, media_mime) VALUES ($1,$2,$3,$4)`, jobID, request.MessageID, request.MediaKey, request.MediaMime)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	event := map[string]any{"id": uuid.NewString(), "type": "media.audio.requested", "occurredAt": time.Now().UTC(), "source": "api", "data": map[string]any{"jobId": jobID.String(), "messageId": request.MessageID, "mediaKey": request.MediaKey, "mediaMime": request.MediaMime}}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("media.audio.requested", payload); err != nil {
		writeJSON(w, 502, map[string]string{"error": "event bus unavailable"})
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID, "status": "queued"})
}

func (a *app) metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "text/plain; version=0.0.4")
	fmt.Fprintln(w, "# HELP wagi_api_up API process health")
	fmt.Fprintln(w, "# TYPE wagi_api_up gauge")
	fmt.Fprintln(w, "wagi_api_up 1")
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("access-control-allow-origin", "*")
		w.Header().Set("access-control-allow-methods", "GET,POST,PUT,OPTIONS")
		w.Header().Set("access-control-allow-headers", "content-type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	ctx := context.Background()
	databaseURL := env("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app?sslmode=disable")
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	natsConn, err := nats.Connect(env("NATS_URL", "nats://localhost:4222"))
	if err != nil {
		log.Fatal(err)
	}
	defer natsConn.Drain()
	js, err := natsConn.JetStream()
	if err != nil {
		log.Fatal(err)
	}
	if err := ensureEventStream(js); err != nil {
		log.Fatal(err)
	}
	a := &app{db: db, nc: natsConn, js: js}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", a.health)
	mux.HandleFunc("/readyz", a.ready)
	mux.HandleFunc("/metrics", a.metrics)
	mux.HandleFunc("/api/v1/groups", a.groups)
	mux.HandleFunc("/api/v1/groups/", a.selectGroup)
	mux.HandleFunc("/api/v1/messages", a.messages)
	mux.HandleFunc("/api/v1/audio/jobs", a.audioJob)
	port := env("PORT", "8080")
	log.Printf("wagi api listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, cors(mux)))
}
