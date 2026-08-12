package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

type app struct {
	db                *pgxpool.Pool
	nc                *nats.Conn
	js                nats.JetStreamContext
	mediaDir          string
	mediaSecret       string
	corsOrigin        string
	waPoolSize        int
	tgPoolSize        int
	waOnboardingSlots int
	tgOnboardingSlots int
}

type group struct {
	ID               string    `json:"id"`
	Subject          string    `json:"subject"`
	ParticipantCount int       `json:"participantCount"`
	IsSelected       bool      `json:"isSelected"`
	Platform         string    `json:"platform"`
	ChatType         string    `json:"chatType"`
	Language         *string   `json:"language,omitempty"`
	ParentGroupID    *string   `json:"parentGroupId,omitempty"`
	TopicID          *int64    `json:"topicId,omitempty"`
	DiscoveredAt     time.Time `json:"discoveredAt"`
}

type message struct {
	ID                 string          `json:"id"`
	GroupID            string          `json:"groupId"`
	GroupSubject       string          `json:"groupSubject"`
	WAMessageID        string          `json:"waMessageId"`
	SenderJID          string          `json:"senderJid"`
	SenderName         *string         `json:"senderName,omitempty"`
	Kind               string          `json:"kind"`
	Text               *string         `json:"text,omitempty"`
	ReplyToWAID        *string         `json:"replyToWaMessageId,omitempty"`
	Platform           string          `json:"platform"`
	ImageURL           string          `json:"imageUrl,omitempty"`
	MediaURL           string          `json:"mediaUrl,omitempty"`
	ThumbnailURL       string          `json:"thumbnailUrl,omitempty"`
	Transcript         *string         `json:"transcript,omitempty"`
	AudioStatus        *string         `json:"audioStatus,omitempty"`
	AudioJobID         *string         `json:"audioJobId,omitempty"`
	AudioAttempts      int             `json:"audioAttempts,omitempty"`
	AudioError         *string         `json:"audioError,omitempty"`
	AudioNextAttemptAt *time.Time      `json:"audioNextAttemptAt,omitempty"`
	MediaStatus        string          `json:"mediaStatus,omitempty"`
	OCRText            *string         `json:"ocrText,omitempty"`
	DeletedAt          *time.Time      `json:"deletedAt,omitempty"`
	ReceivedAt         time.Time       `json:"receivedAt"`
	HasMedia           bool            `json:"hasMedia"`
	Analysis           json.RawMessage `json:"analysis,omitempty"`
}

type audioJobRequest struct {
	MessageID string `json:"messageId"`
	MediaKey  string `json:"mediaKey"`
	MediaMime string `json:"mediaMime"`
}

type audioTranscriptRequest struct {
	Transcript string   `json:"transcript"`
	Language   string   `json:"language,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type audioJobView struct {
	ID            string     `json:"id"`
	MessageID     string     `json:"messageId"`
	GroupID       string     `json:"groupId"`
	GroupSubject  string     `json:"groupSubject"`
	MediaKey      string     `json:"mediaKey"`
	MediaMime     *string    `json:"mediaMime,omitempty"`
	Status        string     `json:"status"`
	Transcript    *string    `json:"transcript,omitempty"`
	Language      *string    `json:"language,omitempty"`
	Confidence    *float64   `json:"confidence,omitempty"`
	Attempts      int        `json:"attempts"`
	Error         *string    `json:"error,omitempty"`
	NextAttemptAt *time.Time `json:"nextAttemptAt,omitempty"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type connectorStatusView struct {
	Connector     string    `json:"connector"`
	Status        string    `json:"status"`
	Detail        *string   `json:"detail,omitempty"`
	LastError     *string   `json:"lastError,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
	QueuePosition *int      `json:"queuePosition,omitempty"`
	QueueLength   *int      `json:"queueLength,omitempty"`
	WaitReason    *string   `json:"waitReason,omitempty"`
}

type aiProcessingView struct {
	Total         int64      `json:"total"`
	Completed     int64      `json:"completed"`
	Pending       int64      `json:"pending"`
	Model         *string    `json:"model,omitempty"`
	PromptVersion *string    `json:"promptVersion,omitempty"`
	UpdatedAt     *time.Time `json:"updatedAt,omitempty"`
}

type serviceStatusView struct {
	Connectors        []connectorStatusView `json:"connectors"`
	AudioJobs         map[string]int        `json:"audioJobs"`
	RecentAudioErrors []audioJobView        `json:"recentAudioErrors"`
	AIProcessing      aiProcessingView      `json:"aiProcessing"`
}

type knowledgeItem struct {
	ID               string                   `json:"id"`
	ItemType         string                   `json:"itemType"`
	ItemRole         string                   `json:"itemRole"`
	Content          string                   `json:"content"`
	Confidence       float64                  `json:"confidence"`
	SourceMessageIDs []string                 `json:"sourceMessageIds"`
	SourceMessages   []knowledgeSourceMessage `json:"sourceMessages,omitempty"`
	UpdatedAt        time.Time                `json:"updatedAt"`
	Children         []knowledgeItem          `json:"children,omitempty"`
}

type knowledgeTopic struct {
	ID               string          `json:"id"`
	GroupID          string          `json:"groupId"`
	GroupSubject     string          `json:"groupSubject"`
	TopicKey         string          `json:"topicKey"`
	Title            string          `json:"title"`
	Summary          string          `json:"summary"`
	Confidence       float64         `json:"confidence"`
	SourceMessageIDs []string        `json:"sourceMessageIds"`
	Items            []knowledgeItem `json:"items"`
	UpdatedAt        time.Time       `json:"updatedAt"`
}

type knowledgeSourceMessage struct {
	ID           string    `json:"id"`
	GroupID      string    `json:"groupId"`
	SenderJID    string    `json:"senderJid"`
	SenderName   *string   `json:"senderName,omitempty"`
	Kind         string    `json:"kind"`
	Text         *string   `json:"text,omitempty"`
	MediaMime    *string   `json:"mediaMime,omitempty"`
	MediaStatus  string    `json:"mediaStatus,omitempty"`
	ReceivedAt   time.Time `json:"receivedAt"`
	HasMedia     bool      `json:"hasMedia"`
	ImageURL     string    `json:"imageUrl,omitempty"`
	MediaURL     string    `json:"mediaUrl,omitempty"`
	ThumbnailURL string    `json:"thumbnailUrl,omitempty"`
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func ensureEventStream(js nats.JetStreamContext) error {
	if _, err := js.StreamInfo("WAGI_EVENTS"); err == nil {
		return nil
	}
	_, err := js.AddStream(&nats.StreamConfig{
		Name:     "WAGI_EVENTS",
		Subjects: []string{"wa.>", "media.>", "ai.>", "connector.>", "replay.>"},
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
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	args := make([]any, 0, 1)
	visibility := groupReadCondition(user, "g", &args)
	selection := "g.is_selected"
	join := ""
	if !user.isAdmin() {
		args = append(args, user.ID)
		join = " LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid"
		selection = "COALESCE(uga.is_selected,FALSE)"
	}
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`SELECT g.id, g.subject, g.participant_count, %s, g.platform, g.chat_type, g.language, g.parent_group_id, g.topic_id, g.discovered_at FROM wa_groups g%s WHERE %s ORDER BY g.platform, COALESCE(g.parent_group_id, g.id), CASE WHEN g.chat_type='topic' THEN 1 ELSE 0 END, g.subject`, selection, join, visibility), args...)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	result := make([]group, 0)
	for rows.Next() {
		var item group
		if err := rows.Scan(&item.ID, &item.Subject, &item.ParticipantCount, &item.IsSelected, &item.Platform, &item.ChatType, &item.Language, &item.ParentGroupID, &item.TopicID, &item.DiscoveredAt); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, 200, result)
}

func (a *app) messages(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		}
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
			offset = parsed
		}
	}
	args := make([]any, 0)
	arg := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	conditions := []string{groupSelectedCondition(user, "g", &args)}
	conditions = append(conditions, groupReadCondition(user, "g", &args))
	if value := strings.TrimSpace(r.URL.Query().Get("q")); value != "" {
		placeholder := arg("%" + value + "%")
		conditions = append(conditions, fmt.Sprintf("(m.text ILIKE %s OR g.subject ILIKE %s OR m.raw::text ILIKE %s)", placeholder, placeholder, placeholder))
	}
	if value := strings.TrimSpace(r.URL.Query().Get("groupId")); value != "" {
		conditions = append(conditions, "m.group_id = "+arg(value))
	}
	if value := strings.TrimSpace(r.URL.Query().Get("kind")); value != "" {
		conditions = append(conditions, "m.kind = "+arg(value))
	}
	if r.URL.Query().Get("relevant") == "true" {
		conditions = append(conditions, "COALESCE(a.relevant, FALSE) = TRUE")
	}
	if r.URL.Query().Get("event") == "true" {
		conditions = append(conditions, "COALESCE(jsonb_array_length(a.events), 0) > 0")
	}
	if r.URL.Query().Get("place") == "true" {
		conditions = append(conditions, "COALESCE(jsonb_array_length(a.places), 0) > 0")
	}
	if value := strings.TrimSpace(r.URL.Query().Get("from")); value != "" {
		conditions = append(conditions, "m.received_at >= "+arg(value))
	}
	if value := strings.TrimSpace(r.URL.Query().Get("to")); value != "" {
		conditions = append(conditions, "m.received_at < "+arg(value))
	}
	// Fetch one extra row so the client can render a reliable next-page state
	// without changing the long-standing array response shape.
	args = append(args, limit+1)
	limitArg := fmt.Sprintf("$%d", len(args))
	args = append(args, offset)
	offsetArg := fmt.Sprintf("$%d", len(args))
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT m.id, m.group_id, g.subject, m.wa_message_id, m.sender_jid, m.sender_name, m.kind,
		       COALESCE(NULLIF(aj.transcript, ''), m.text),
		       COALESCE(
		         CASE WHEN NULLIF(m.raw #>> '{message,extendedTextMessage,contextInfo,stanzaId}', '') IS NOT NULL
		              THEN m.group_id || ':' || (m.raw #>> '{message,extendedTextMessage,contextInfo,stanzaId}') END,
		         CASE WHEN m.raw ? 'reply_to_message'
		              THEN m.group_id || ':' || (m.raw #>> '{reply_to_message,message_id}') END),
		       COALESCE(m.platform, CASE WHEN m.group_id LIKE 'tg:%%' THEN 'telegram' ELSE 'whatsapp' END),
		       m.received_at, m.has_media, m.media_status, m.deleted_at,
		       mo.object_path, mo.thumbnail_path, mo.ocr_text, aj.id::text, aj.transcript, aj.status, aj.attempts, aj.error, aj.next_attempt_at,
		       COALESCE(jsonb_build_object('relevant', a.relevant, 'score', a.relevance_score, 'summary', a.summary, 'facts', a.facts, 'entities', a.entities, 'events', a.events, 'places', a.places, 'model', a.model, 'schemaVersion', a.schema_version, 'promptVersion', a.prompt_version, 'provenance', a.provenance, 'conflicts', a.conflicts), '{}'::jsonb)
		FROM messages m JOIN wa_groups g ON g.id = m.group_id
		LEFT JOIN message_analyses a ON a.message_id = m.id
		LEFT JOIN LATERAL (SELECT object_path, thumbnail_path, ocr_text FROM media_objects WHERE message_id=m.id ORDER BY updated_at DESC LIMIT 1) mo ON TRUE
		LEFT JOIN LATERAL (SELECT id, transcript, status, attempts, error, next_attempt_at FROM audio_jobs WHERE message_id=m.id ORDER BY updated_at DESC LIMIT 1) aj ON TRUE
		WHERE %s ORDER BY m.received_at DESC LIMIT %s OFFSET %s`, strings.Join(conditions, " AND "), limitArg, offsetArg), args...)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	result := make([]message, 0)
	for rows.Next() {
		var item message
		var objectPath, thumbnailPath *string
		var audioAttempts *int
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupSubject, &item.WAMessageID, &item.SenderJID, &item.SenderName, &item.Kind, &item.Text, &item.ReplyToWAID, &item.Platform, &item.ReceivedAt, &item.HasMedia, &item.MediaStatus, &item.DeletedAt, &objectPath, &thumbnailPath, &item.OCRText, &item.AudioJobID, &item.Transcript, &item.AudioStatus, &audioAttempts, &item.AudioError, &item.AudioNextAttemptAt, &item.Analysis); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if audioAttempts != nil {
			item.AudioAttempts = *audioAttempts
		}
		item.ImageURL = mockImageURL(item.GroupID, item.Text)
		if (item.Kind == "image" || item.Kind == "video") && item.HasMedia && (item.Platform == "telegram" || !strings.HasPrefix(item.GroupID, "120363mock")) {
			item.MediaURL = a.signedMediaURL(item.ID, false)
			item.ThumbnailURL = a.signedMediaURL(item.ID, true)
		} else if objectPath != nil && *objectPath != "" {
			item.MediaURL = a.signedMediaURL(item.ID, false)
			if thumbnailPath != nil && *thumbnailPath != "" {
				item.ThumbnailURL = a.signedMediaURL(item.ID, true)
			}
		}
		result = append(result, item)
	}
	hasMore := len(result) > limit
	if hasMore {
		result = result[:limit]
	}
	w.Header().Set("X-Has-More", strconv.FormatBool(hasMore))
	w.Header().Set("X-Next-Offset", strconv.Itoa(offset+limit))
	w.Header().Set("X-Page-Offset", strconv.Itoa(offset))
	w.Header().Set("X-Page-Limit", strconv.Itoa(limit))
	writeJSON(w, 200, result)
}

func (a *app) signedMediaURL(messageID string, thumbnail bool) string {
	expires := time.Now().Add(10 * time.Minute).Unix()
	return fmt.Sprintf("/api/v1/media/%s?thumbnail=%d&expires=%d&token=%s", messageID, boolToInt(thumbnail), expires, a.mediaToken(messageID, thumbnail, expires))
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (a *app) mediaToken(messageID string, thumbnail bool, expires int64) string {
	mac := hmac.New(sha256.New, []byte(a.mediaSecret))
	_, _ = fmt.Fprintf(mac, "%s|%t|%d", messageID, thumbnail, expires)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *app) mediaImage(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	messageID := strings.TrimPrefix(r.URL.Path, "/api/v1/media/")
	thumbnail := r.URL.Query().Get("thumbnail") == "1"
	expires, parseErr := strconv.ParseInt(r.URL.Query().Get("expires"), 10, 64)
	token := r.URL.Query().Get("token")
	if messageID == "" || strings.Contains(messageID, "/") || parseErr != nil || expires < time.Now().Unix() || !hmac.Equal([]byte(token), []byte(a.mediaToken(messageID, thumbnail, expires))) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "media URL expired or invalid"})
		return
	}
	var mediaKey, mediaMime, platform, waMessageID, kind string
	var objectPath, thumbnailPath *string
	var storedMime *string
	mediaArgs := []any{messageID}
	visibility := groupReadCondition(user, "g", &mediaArgs)
	selection := groupSelectedCondition(user, "g", &mediaArgs)
	err := a.db.QueryRow(r.Context(), fmt.Sprintf(`
		SELECT COALESCE(m.media_key, ''), COALESCE(m.media_mime, ''), COALESCE(m.platform, ''), COALESCE(m.wa_message_id, ''), m.kind, mo.object_path, mo.thumbnail_path, mo.mime
		FROM messages m
		JOIN wa_groups g ON g.id = m.group_id
		LEFT JOIN LATERAL (
			SELECT object_path, thumbnail_path, mime FROM media_objects
			WHERE message_id = m.id ORDER BY updated_at DESC LIMIT 1
		) mo ON TRUE
		WHERE m.id = $1::uuid AND m.has_media = TRUE AND m.kind IN ('image', 'video') AND %s AND %s`, visibility, selection), mediaArgs...).
		Scan(&mediaKey, &mediaMime, &platform, &waMessageID, &kind, &objectPath, &thumbnailPath, &storedMime)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "media lookup failed"})
		return
	}
	requestedPath := objectPath
	if thumbnail && thumbnailPath != nil && *thumbnailPath != "" {
		requestedPath = thumbnailPath
	}
	if requestedPath == nil || *requestedPath == "" {
		fallbackKey := mediaKey
		// WhatsApp stores the downloaded source as <waMessageID>.<extension>.
		// The media key contains the group JID as a prefix and therefore cannot
		// be used to reconstruct that local path.
		if platform == "whatsapp" && waMessageID != "" {
			fallbackKey = waMessageID
		}
		safeKey := strings.Map(func(value rune) rune {
			if (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '_' || value == '-' {
				return value
			}
			return '_'
		}, fallbackKey)
		extension := "jpeg"
		mediaType := strings.Split(mediaMime, ";")[0]
		if slash := strings.Index(mediaType, "/"); slash >= 0 && slash+1 < len(mediaType) {
			extension = strings.Map(func(value rune) rune {
				if (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') {
					return value
				}
				return -1
			}, mediaType[slash+1:])
		}
		if extension == "" {
			if values, _ := mime.ExtensionsByType(mediaType); len(values) > 0 {
				extension = strings.TrimPrefix(values[0], ".")
			}
		}
		fallback := filepath.Join(a.mediaDir, "incoming", safeKey+"."+extension)
		requestedPath = &fallback
	}
	root, err := filepath.Abs(a.mediaDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "media root unavailable"})
		return
	}
	filePath, err := filepath.Abs(*requestedPath)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid media path"})
		return
	}
	relative, err := filepath.Rel(root, filePath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "invalid media path"})
		return
	}
	file, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media file not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "media file unavailable"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "media file unavailable"})
		return
	}
	contentType := mediaMime
	if storedMime != nil && *storedMime != "" {
		contentType = *storedMime
	}
	if contentType == "" {
		contentType = mime.TypeByExtension(filepath.Ext(filePath))
	}
	if contentType == "" && kind == "video" {
		// Telegram can store an MP4 with a generic .video filename and no MIME
		// metadata. Keep the native video player usable in that case.
		contentType = "video/mp4"
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("content-type", contentType)
	w.Header().Set("cache-control", "private, max-age=300")
	http.ServeContent(w, r, filepath.Base(filePath), info.ModTime(), file)
}

func (a *app) knowledge(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	args := make([]any, 0)
	arg := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	conditions := []string{groupSelectedCondition(user, "g", &args)}
	conditions = append(conditions, groupReadCondition(user, "g", &args))
	if value := strings.TrimSpace(r.URL.Query().Get("groupId")); value != "" {
		conditions = append(conditions, "kt.group_id = "+arg(value))
	}
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT kt.id::text, kt.group_id, g.subject, kt.topic_key, kt.title, kt.summary, kt.confidence,
		       kt.source_message_ids,
		       COALESCE(jsonb_agg(jsonb_build_object(
		         'id', parent.id::text,
		         'itemType', parent.item_type,
		         'itemRole', parent.item_role,
		         'content', parent.content,
		         'confidence', parent.confidence,
		         'sourceMessageIds', parent.source_message_ids,
		         'updatedAt', parent.updated_at,
		         'children', COALESCE((
		           SELECT jsonb_agg(jsonb_build_object(
		             'id', child.id::text,
		             'itemType', child.item_type,
		             'itemRole', child.item_role,
		             'content', child.content,
		             'confidence', child.confidence,
		             'sourceMessageIds', child.source_message_ids,
		             'updatedAt', child.updated_at
		           ) ORDER BY child.updated_at DESC)
		           FROM knowledge_items child WHERE child.parent_item_id = parent.id
		         ), '[]'::jsonb)
		       ) ORDER BY parent.updated_at DESC) FILTER (WHERE parent.id IS NOT NULL), '[]'::jsonb), kt.updated_at
		FROM knowledge_topics kt
		JOIN wa_groups g ON g.id = kt.group_id
		LEFT JOIN knowledge_items parent ON parent.topic_id = kt.id AND parent.parent_item_id IS NULL
		WHERE %s
		GROUP BY kt.id, kt.group_id, g.subject, kt.topic_key, kt.title, kt.summary, kt.confidence, kt.source_message_ids, kt.updated_at
		ORDER BY kt.updated_at DESC, g.subject`, strings.Join(conditions, " AND ")), args...)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	result := make([]knowledgeTopic, 0)
	for rows.Next() {
		var item knowledgeTopic
		var topicSourceIDs json.RawMessage
		var itemsJSON json.RawMessage
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupSubject, &item.TopicKey, &item.Title, &item.Summary, &item.Confidence, &topicSourceIDs, &itemsJSON, &item.UpdatedAt); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if err := json.Unmarshal(topicSourceIDs, &item.SourceMessageIDs); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if err := json.Unmarshal(itemsJSON, &item.Items); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		result = append(result, item)
	}
	if err := a.hydrateKnowledgeTopics(r.Context(), result); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, result)
}

func collectKnowledgeSourceIDs(items []knowledgeItem, ids map[string]struct{}) {
	for _, item := range items {
		for _, sourceID := range item.SourceMessageIDs {
			if sourceID != "" {
				ids[sourceID] = struct{}{}
			}
		}
		collectKnowledgeSourceIDs(item.Children, ids)
	}
}

func (a *app) hydrateKnowledgeItems(items []knowledgeItem, sources map[string]knowledgeSourceMessage) {
	for index := range items {
		item := &items[index]
		item.SourceMessages = make([]knowledgeSourceMessage, 0, len(item.SourceMessageIDs))
		for _, sourceID := range item.SourceMessageIDs {
			source, ok := sources[sourceID]
			if !ok {
				continue
			}
			if source.Kind == "image" || source.Kind == "video" {
				source.ImageURL = mockImageURL(source.GroupID, source.Text)
				if source.HasMedia && !strings.HasPrefix(source.GroupID, "120363mock") {
					source.MediaURL = a.signedMediaURL(source.ID, false)
					source.ThumbnailURL = a.signedMediaURL(source.ID, true)
				}
			}
			item.SourceMessages = append(item.SourceMessages, source)
		}
		a.hydrateKnowledgeItems(item.Children, sources)
	}
}

func (a *app) hydrateKnowledgeTopics(ctx context.Context, topics []knowledgeTopic) error {
	ids := make(map[string]struct{})
	for _, topic := range topics {
		collectKnowledgeSourceIDs(topic.Items, ids)
	}
	if len(ids) == 0 {
		return nil
	}

	sourceIDs := make([]string, 0, len(ids))
	for sourceID := range ids {
		sourceIDs = append(sourceIDs, sourceID)
	}
	rows, err := a.db.Query(ctx, `
		SELECT m.id::text, m.group_id, m.sender_jid, m.sender_name, m.kind,
		       COALESCE(NULLIF(aj.transcript, ''), m.text),
		       m.media_mime, m.media_status, m.received_at, m.has_media
		FROM messages m
		LEFT JOIN LATERAL (
			SELECT transcript
			FROM audio_jobs
			WHERE message_id = m.id AND NULLIF(transcript, '') IS NOT NULL
			ORDER BY updated_at DESC
			LIMIT 1
		) aj ON TRUE
		WHERE m.id::text = ANY($1::text[])`, sourceIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	sources := make(map[string]knowledgeSourceMessage, len(sourceIDs))
	for rows.Next() {
		var source knowledgeSourceMessage
		if err := rows.Scan(&source.ID, &source.GroupID, &source.SenderJID, &source.SenderName, &source.Kind, &source.Text, &source.MediaMime, &source.MediaStatus, &source.ReceivedAt, &source.HasMedia); err != nil {
			return err
		}
		sources[source.ID] = source
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range topics {
		a.hydrateKnowledgeItems(topics[index].Items, sources)
	}
	return nil
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
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
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
	var err error
	if user.isAdmin() {
		err = a.db.QueryRow(r.Context(), `UPDATE wa_groups SET is_selected = $1, updated_at = NOW() WHERE id = $2 RETURNING id, subject, participant_count, is_selected, platform, chat_type, language, parent_group_id, topic_id, discovered_at`, body.Selected, groupID).Scan(&item.ID, &item.Subject, &item.ParticipantCount, &item.IsSelected, &item.Platform, &item.ChatType, &item.Language, &item.ParentGroupID, &item.TopicID, &item.DiscoveredAt)
	} else {
		err = a.db.QueryRow(r.Context(), `UPDATE user_group_access uga
			SET is_selected=$1
			FROM wa_groups g
			WHERE uga.user_id=$2::uuid AND uga.group_id=$3 AND uga.can_manage=TRUE AND g.id=uga.group_id
			RETURNING g.id, g.subject, g.participant_count, uga.is_selected, g.platform, g.chat_type, g.language, g.parent_group_id, g.topic_id, g.discovered_at`, body.Selected, user.ID, groupID).Scan(&item.ID, &item.Subject, &item.ParticipantCount, &item.IsSelected, &item.Platform, &item.ChatType, &item.Language, &item.ParentGroupID, &item.TopicID, &item.DiscoveredAt)
	}
	if err == pgx.ErrNoRows {
		writeJSON(w, 404, map[string]string{"error": "group not found"})
		return
	}
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"id":         uuid.NewString(),
		"type":       "connector.group.selection.changed",
		"occurredAt": time.Now().UTC(),
		"source":     "api",
		"data": map[string]any{
			"groupId":  item.ID,
			"selected": item.IsSelected,
			"platform": item.Platform,
		},
	})
	if err := a.nc.Publish("connector.group.selection.changed", payload); err != nil {
		log.Printf("group selection event publish failed: %v", err)
	}
	writeJSON(w, 200, item)
}

func (a *app) audioJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.listAudioJobs(w, r)
		return
	}
	if r.Method == http.MethodPost {
		a.createAudioJob(w, r)
		return
	}
	w.Header().Set("allow", "GET, POST")
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func (a *app) listAudioJobs(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 500 {
			limit = parsed
		}
	}
	args := make([]any, 0, 2)
	selection := groupSelectedCondition(user, "g", &args)
	visibility := groupReadCondition(user, "g", &args)
	args = append(args, limit)
	limitArg := fmt.Sprintf("$%d", len(args))
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT aj.id::text, aj.message_id::text, m.group_id, g.subject, aj.media_key, aj.media_mime,
		       aj.status, aj.transcript, aj.language, aj.confidence, aj.attempts, aj.error,
		       aj.next_attempt_at, aj.updated_at
		FROM audio_jobs aj
		JOIN messages m ON m.id = aj.message_id
		JOIN wa_groups g ON g.id = m.group_id
		WHERE %s AND %s
		ORDER BY aj.updated_at DESC LIMIT %s`, selection, visibility, limitArg), args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "audio jobs unavailable"})
		return
	}
	defer rows.Close()
	result := make([]audioJobView, 0)
	for rows.Next() {
		var item audioJobView
		if err := rows.Scan(&item.ID, &item.MessageID, &item.GroupID, &item.GroupSubject, &item.MediaKey, &item.MediaMime, &item.Status, &item.Transcript, &item.Language, &item.Confidence, &item.Attempts, &item.Error, &item.NextAttemptAt, &item.UpdatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "audio jobs unavailable"})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *app) createAudioJob(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var request audioJobRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.MessageID == "" || request.MediaKey == "" {
		writeJSON(w, 400, map[string]string{"error": "messageId and mediaKey are required"})
		return
	}
	accessArgs := []any{request.MessageID}
	visibility := groupReadCondition(user, "g", &accessArgs)
	var accessible bool
	if err := a.db.QueryRow(r.Context(), fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM messages m JOIN wa_groups g ON g.id=m.group_id WHERE m.id=$1::uuid AND %s AND %s)`, groupSelectedCondition(user, "g", &accessArgs), visibility), accessArgs...).Scan(&accessible); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "message access could not be checked"})
		return
	}
	if !accessible {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found"})
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

func (a *app) audioJobAction(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/audio/jobs/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 2 || parts[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "audio job action not found"})
		return
	}
	jobID := parts[0]
	switch {
	case parts[1] == "retry" && r.Method == http.MethodPost:
		a.retryAudioJob(w, r, jobID)
	case parts[1] == "transcript" && r.Method == http.MethodPut:
		a.updateAudioTranscript(w, r, jobID)
	default:
		w.Header().Set("allow", "POST, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (a *app) retryAudioJob(w http.ResponseWriter, r *http.Request, jobID string) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var item audioJobView
	var objectPath *string
	args := []any{jobID}
	selection := groupSelectedCondition(user, "g", &args)
	visibility := groupReadCondition(user, "g", &args)
	err := a.db.QueryRow(r.Context(), fmt.Sprintf(`
		UPDATE audio_jobs aj
		SET status='queued', attempts=0, error=NULL, next_attempt_at=NOW(), updated_at=NOW()
		FROM messages m JOIN wa_groups g ON g.id=m.group_id
		WHERE aj.id=$1::uuid AND aj.message_id=m.id AND %s AND %s
		RETURNING aj.id::text, aj.message_id::text, m.group_id, g.subject, aj.media_key, aj.media_mime,
		          aj.status, aj.transcript, aj.language, aj.confidence, aj.attempts, aj.error,
		          aj.next_attempt_at, aj.updated_at, aj.object_path`, selection, visibility), args...).
		Scan(&item.ID, &item.MessageID, &item.GroupID, &item.GroupSubject, &item.MediaKey, &item.MediaMime, &item.Status, &item.Transcript, &item.Language, &item.Confidence, &item.Attempts, &item.Error, &item.NextAttemptAt, &item.UpdatedAt, &objectPath)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "audio job not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "audio job could not be queued"})
		return
	}
	event := map[string]any{"id": uuid.NewString(), "type": "media.audio.requested", "occurredAt": time.Now().UTC(), "source": "api", "data": map[string]any{"jobId": item.ID, "messageId": item.MessageID, "mediaKey": item.MediaKey, "mediaMime": item.MediaMime, "objectPath": objectPath}}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("media.audio.requested", payload); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "event bus unavailable"})
		return
	}
	writeJSON(w, http.StatusAccepted, item)
}

func (a *app) updateAudioTranscript(w http.ResponseWriter, r *http.Request, jobID string) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var request audioTranscriptRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.Transcript) == "" || len(request.Transcript) > 200000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "transcript must contain between 1 and 200000 characters"})
		return
	}
	var item audioJobView
	var objectPath *string
	args := []any{jobID, strings.TrimSpace(request.Transcript), strings.TrimSpace(request.Language), request.Confidence}
	selection := groupSelectedCondition(user, "g", &args)
	visibility := groupReadCondition(user, "g", &args)
	err := a.db.QueryRow(r.Context(), fmt.Sprintf(`
		UPDATE audio_jobs aj
		SET status='completed', transcript=$2, language=NULLIF($3,''), confidence=$4, error=NULL, next_attempt_at=NULL, updated_at=NOW()
		FROM messages m JOIN wa_groups g ON g.id=m.group_id
		WHERE aj.id=$1::uuid AND aj.message_id=m.id AND %s AND %s
		RETURNING aj.id::text, aj.message_id::text, m.group_id, g.subject, aj.media_key, aj.media_mime,
		          aj.status, aj.transcript, aj.language, aj.confidence, aj.attempts, aj.error,
		          aj.next_attempt_at, aj.updated_at, aj.object_path`, selection, visibility), args...).
		Scan(&item.ID, &item.MessageID, &item.GroupID, &item.GroupSubject, &item.MediaKey, &item.MediaMime, &item.Status, &item.Transcript, &item.Language, &item.Confidence, &item.Attempts, &item.Error, &item.NextAttemptAt, &item.UpdatedAt, &objectPath)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "audio job not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "transcript could not be saved"})
		return
	}
	event := map[string]any{"id": uuid.NewString(), "type": "media.audio.transcribed", "occurredAt": time.Now().UTC(), "source": "api", "data": map[string]any{"jobId": item.ID, "messageId": item.MessageID, "mediaKey": item.MediaKey, "transcript": strings.TrimSpace(request.Transcript), "language": request.Language, "confidence": request.Confidence, "provider": "user-correction", "objectPath": objectPath}}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("media.audio.transcribed", payload); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "event bus unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *app) status(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	result := serviceStatusView{Connectors: make([]connectorStatusView, 0), AudioJobs: map[string]int{}, RecentAudioErrors: make([]audioJobView, 0)}
	connectorRows, err := a.db.Query(r.Context(), `SELECT id::text, platform, status, last_error, updated_at FROM connector_accounts WHERE user_id=$1::uuid ORDER BY platform`, user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
		return
	}
	for connectorRows.Next() {
		var accountID string
		var item connectorStatusView
		if err := connectorRows.Scan(&accountID, &item.Connector, &item.Status, &item.LastError, &item.UpdatedAt); err != nil {
			connectorRows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
			return
		}
		queuePosition, queueLength, waitReason, _, queueErr := a.connectorQueueInfo(r.Context(), accountID, item.Connector)
		if queueErr != nil {
			connectorRows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
			return
		}
		item.QueuePosition = queuePosition
		item.QueueLength = queueLength
		item.WaitReason = waitReason
		result.Connectors = append(result.Connectors, item)
	}
	connectorRows.Close()
	jobArgs := make([]any, 0, 1)
	jobVisibility := groupReadCondition(user, "g", &jobArgs)
	jobRows, err := a.db.Query(r.Context(), fmt.Sprintf(`SELECT status, COUNT(*) FROM audio_jobs aj JOIN messages m ON m.id=aj.message_id JOIN wa_groups g ON g.id=m.group_id WHERE %s AND %s GROUP BY status`, groupSelectedCondition(user, "g", &jobArgs), jobVisibility), jobArgs...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
		return
	}
	for jobRows.Next() {
		var status string
		var count int
		if err := jobRows.Scan(&status, &count); err != nil {
			jobRows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
			return
		}
		result.AudioJobs[status] = count
	}
	jobRows.Close()
	aiArgs := make([]any, 0, 1)
	aiConditions := []string{groupSelectedCondition(user, "g", &aiArgs), groupReadCondition(user, "g", &aiArgs)}
	if err := a.db.QueryRow(r.Context(), fmt.Sprintf(`
		SELECT COUNT(*)::bigint,
		       COUNT(a.message_id)::bigint,
		       COUNT(*) FILTER (WHERE a.message_id IS NULL)::bigint,
		       MAX(a.updated_at)
		FROM messages m
		JOIN wa_groups g ON g.id=m.group_id
		LEFT JOIN message_analyses a ON a.message_id=m.id
		WHERE %s AND %s`, aiConditions[0], aiConditions[1]), aiArgs...).Scan(&result.AIProcessing.Total, &result.AIProcessing.Completed, &result.AIProcessing.Pending, &result.AIProcessing.UpdatedAt); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
		return
	}
	var latestModel, latestPromptVersion *string
	if err := a.db.QueryRow(r.Context(), fmt.Sprintf(`
		SELECT NULLIF(a.model, ''), NULLIF(a.prompt_version, '')
		FROM message_analyses a
		JOIN messages m ON m.id=a.message_id
		JOIN wa_groups g ON g.id=m.group_id
		WHERE %s AND %s
		ORDER BY a.updated_at DESC
		LIMIT 1`, aiConditions[0], aiConditions[1]), aiArgs...).Scan(&latestModel, &latestPromptVersion); err != nil && err != pgx.ErrNoRows {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
		return
	}
	result.AIProcessing.Model = latestModel
	result.AIProcessing.PromptVersion = latestPromptVersion
	errorArgs := make([]any, 0, 1)
	errorVisibility := groupReadCondition(user, "g", &errorArgs)
	errorRows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT aj.id::text, aj.message_id::text, m.group_id, g.subject, aj.media_key, aj.media_mime,
		       aj.status, aj.transcript, aj.language, aj.confidence, aj.attempts, aj.error,
		       aj.next_attempt_at, aj.updated_at
		FROM audio_jobs aj JOIN messages m ON m.id=aj.message_id JOIN wa_groups g ON g.id=m.group_id
		WHERE aj.status='failed' AND %s AND %s ORDER BY aj.updated_at DESC LIMIT 10`, groupSelectedCondition(user, "g", &errorArgs), errorVisibility), errorArgs...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
		return
	}
	for errorRows.Next() {
		var item audioJobView
		if err := errorRows.Scan(&item.ID, &item.MessageID, &item.GroupID, &item.GroupSubject, &item.MediaKey, &item.MediaMime, &item.Status, &item.Transcript, &item.Language, &item.Confidence, &item.Attempts, &item.Error, &item.NextAttemptAt, &item.UpdatedAt); err != nil {
			errorRows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "status unavailable"})
			return
		}
		result.RecentAudioErrors = append(result.RecentAudioErrors, item)
	}
	errorRows.Close()
	writeJSON(w, http.StatusOK, result)
}

func (a *app) metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "text/plain; version=0.0.4")
	fmt.Fprintln(w, "# HELP wagi_api_up API process health")
	fmt.Fprintln(w, "# TYPE wagi_api_up gauge")
	fmt.Fprintln(w, "wagi_api_up 1")
}

func cors(origin string, next http.Handler) http.Handler {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		// The normal deployment is same-origin through the NGINX /api/ proxy.
		// Browsers do not apply CORS to those relative requests.
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("access-control-allow-origin", origin)
		w.Header().Set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("access-control-allow-headers", "content-type")
		w.Header().Set("access-control-allow-credentials", "true")
		w.Header().Set("access-control-expose-headers", "X-Has-More, X-Next-Offset, X-Page-Offset, X-Page-Limit")
		w.Header().Set("vary", "Origin")
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
	a := &app{
		db:                db,
		nc:                natsConn,
		js:                js,
		mediaDir:          env("MEDIA_DIR", "/data/media"),
		mediaSecret:       env("MEDIA_SIGNING_SECRET", uuid.NewString()),
		corsOrigin:        env("WAGI_CORS_ORIGIN", ""),
		waPoolSize:        envInt("WA_CONNECTOR_POOL_SIZE", 5),
		tgPoolSize:        envInt("TG_CONNECTOR_POOL_SIZE", 5),
		waOnboardingSlots: envInt("WA_ONBOARDING_SLOTS", 1),
		tgOnboardingSlots: envInt("TG_ONBOARDING_SLOTS", 1),
	}
	if err := a.bootstrapAdmin(); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", a.health)
	mux.HandleFunc("/readyz", a.ready)
	mux.HandleFunc("/metrics", a.metrics)
	mux.HandleFunc("/api/v1/auth/me", a.authMe)
	mux.HandleFunc("/api/v1/auth/login", a.authLogin)
	mux.HandleFunc("/api/v1/auth/logout", a.authLogout)
	mux.HandleFunc("/api/v1/auth/register", a.authRegister)
	mux.HandleFunc("/api/v1/admin/users", requireAdmin(a, a.adminUsers))
	mux.HandleFunc("/api/v1/admin/users/", requireAdmin(a, a.adminUsers))
	mux.HandleFunc("/api/v1/admin/observability", requireAdmin(a, a.adminObservability))
	mux.HandleFunc("/api/v1/connectors/accounts", requireAuthenticated(a, a.connectorAccounts))
	mux.HandleFunc("/api/v1/connectors/accounts/", requireAuthenticated(a, a.connectorAccountAction))
	mux.HandleFunc("/api/v1/status", requireAuthenticated(a, a.status))
	mux.HandleFunc("/api/v1/groups", requireAuthenticated(a, a.groups))
	mux.HandleFunc("/api/v1/groups/", requireAuthenticated(a, a.selectGroup))
	mux.HandleFunc("/api/v1/messages", requireAuthenticated(a, a.messages))
	mux.HandleFunc("/api/v1/media/", requireAuthenticated(a, a.mediaImage))
	mux.HandleFunc("/api/v1/knowledge", requireAuthenticated(a, a.knowledge))
	mux.HandleFunc("/api/v1/audio/jobs", requireAuthenticated(a, a.audioJobs))
	mux.HandleFunc("/api/v1/audio/jobs/", requireAuthenticated(a, a.audioJobAction))
	mux.HandleFunc("/api/v1/replays", requireAuthenticated(a, a.replays))
	port := env("PORT", "8080")
	log.Printf("wagi api listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, cors(a.corsOrigin, mux)))
}
