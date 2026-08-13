package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

var knowledgeTopicKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)

type knowledgeTopicDefinitionView struct {
	ID          string    `json:"id"`
	Language    string    `json:"language"`
	TopicKey    string    `json:"topicKey"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Enabled     bool      `json:"enabled"`
	SortOrder   int       `json:"sortOrder"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type knowledgeTopicDefinitionPage struct {
	Items      []knowledgeTopicDefinitionView `json:"items"`
	Page       int                            `json:"page"`
	PageSize   int                            `json:"pageSize"`
	Total      int                            `json:"total"`
	TotalPages int                            `json:"totalPages"`
}

type knowledgeTopicDefinitionRequest struct {
	Language    string `json:"language"`
	TopicKey    string `json:"topicKey"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Enabled     *bool  `json:"enabled"`
	SortOrder   *int   `json:"sortOrder"`
}

type knowledgeRebuildJobView struct {
	ID             string     `json:"id"`
	Status         string     `json:"status"`
	TotalCount     int        `json:"totalCount"`
	ProcessedCount int        `json:"processedCount"`
	FailedCount    int        `json:"failedCount"`
	SkippedCount   int        `json:"skippedCount"`
	Error          *string    `json:"error,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	CompletedAt    *time.Time `json:"completedAt,omitempty"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

func parseKnowledgeTopicPage(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

func parseKnowledgeTopicPageSize(value string) int {
	parsed := parseKnowledgeTopicPage(value, 25)
	if parsed > 100 {
		return 100
	}
	if parsed < 10 {
		return 10
	}
	return parsed
}

func normalizeKnowledgeTopicLanguage(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, language := range []string{"de", "es", "ca", "en", "fr"} {
		if value == language {
			return value
		}
	}
	return ""
}

func validateKnowledgeTopicDefinition(request knowledgeTopicDefinitionRequest, requireKey bool) (knowledgeTopicDefinitionRequest, string) {
	request.Language = normalizeKnowledgeTopicLanguage(request.Language)
	request.TopicKey = strings.ToLower(strings.TrimSpace(request.TopicKey))
	request.Title = strings.TrimSpace(request.Title)
	request.Description = strings.TrimSpace(request.Description)
	if request.Language == "" {
		return request, "language must be one of de, es, ca, en or fr"
	}
	if requireKey && !knowledgeTopicKeyPattern.MatchString(request.TopicKey) {
		return request, "topicKey must contain only lowercase letters, numbers, dots, underscores or hyphens"
	}
	if request.TopicKey != "" && !knowledgeTopicKeyPattern.MatchString(request.TopicKey) {
		return request, "topicKey must contain only lowercase letters, numbers, dots, underscores or hyphens"
	}
	if request.Title == "" || len(request.Title) > 180 {
		return request, "title is required and must not exceed 180 characters"
	}
	if len(request.Description) > 1000 {
		return request, "description must not exceed 1000 characters"
	}
	if request.SortOrder == nil {
		defaultOrder := 100
		request.SortOrder = &defaultOrder
	}
	if *request.SortOrder < 0 || *request.SortOrder > 10000 {
		return request, "sortOrder must be between 0 and 10000"
	}
	if request.Enabled == nil {
		enabled := true
		request.Enabled = &enabled
	}
	return request, ""
}

func scanKnowledgeTopicDefinition(row interface{ Scan(...any) error }) (knowledgeTopicDefinitionView, error) {
	var view knowledgeTopicDefinitionView
	err := row.Scan(&view.ID, &view.Language, &view.TopicKey, &view.Title, &view.Description, &view.Enabled, &view.SortOrder, &view.CreatedAt, &view.UpdatedAt)
	return view, err
}

func scanKnowledgeRebuildJob(row interface{ Scan(...any) error }) (knowledgeRebuildJobView, error) {
	var view knowledgeRebuildJobView
	err := row.Scan(&view.ID, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.SkippedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt, &view.UpdatedAt)
	return view, err
}

func (a *app) adminKnowledgeTopics(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/knowledge/topics"), "/")
	if path == "rebuild" {
		a.adminKnowledgeRebuild(w, r)
		return
	}
	if path != "" {
		id, err := uuid.Parse(path)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid knowledge topic id"})
			return
		}
		switch r.Method {
		case http.MethodPatch:
			a.updateKnowledgeTopic(w, r, id)
		case http.MethodDelete:
			a.deleteKnowledgeTopic(w, r, id)
		default:
			w.Header().Set("allow", http.MethodPatch+", "+http.MethodDelete)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.listKnowledgeTopics(w, r)
	case http.MethodPost:
		a.createKnowledgeTopic(w, r)
	default:
		w.Header().Set("allow", http.MethodGet+", "+http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (a *app) listKnowledgeTopics(w http.ResponseWriter, r *http.Request) {
	page := parseKnowledgeTopicPage(r.URL.Query().Get("page"), 1)
	pageSize := parseKnowledgeTopicPageSize(r.URL.Query().Get("pageSize"))
	language := normalizeKnowledgeTopicLanguage(r.URL.Query().Get("language"))
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	conditions := []string{"TRUE"}
	args := make([]any, 0, 3)
	add := func(value any) string { args = append(args, value); return "$" + strconv.Itoa(len(args)) }
	if language != "" {
		conditions = append(conditions, "language="+add(language))
	}
	if search != "" {
		conditions = append(conditions, "(topic_key ILIKE "+add("%"+search+"%")+" OR title ILIKE "+add("%"+search+"%")+" OR description ILIKE "+add("%"+search+"%")+")")
	}
	where := strings.Join(conditions, " AND ")
	var total int
	if err := a.db.QueryRow(r.Context(), "SELECT COUNT(*) FROM knowledge_topic_definitions WHERE "+where, args...).Scan(&total); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge topics unavailable"})
		return
	}
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages == 0 {
		totalPages = 1
	}
	if page > totalPages {
		page = totalPages
	}
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, pageSize, (page-1)*pageSize)
	rows, err := a.db.Query(r.Context(), `SELECT id::text, language, topic_key, title, description, enabled, sort_order, created_at, updated_at
		FROM knowledge_topic_definitions WHERE `+where+` ORDER BY language, sort_order, title LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2), queryArgs...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge topics unavailable"})
		return
	}
	defer rows.Close()
	items := make([]knowledgeTopicDefinitionView, 0, pageSize)
	for rows.Next() {
		view, scanErr := scanKnowledgeTopicDefinition(rows)
		if scanErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge topics unavailable"})
			return
		}
		items = append(items, view)
	}
	writeJSON(w, http.StatusOK, knowledgeTopicDefinitionPage{Items: items, Page: page, PageSize: pageSize, Total: total, TotalPages: totalPages})
}

func (a *app) createKnowledgeTopic(w http.ResponseWriter, r *http.Request) {
	var request knowledgeTopicDefinitionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request, validationError := validateKnowledgeTopicDefinition(request, true)
	if validationError != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": validationError})
		return
	}
	var view knowledgeTopicDefinitionView
	err := a.db.QueryRow(r.Context(), `INSERT INTO knowledge_topic_definitions (language, topic_key, title, description, enabled, sort_order)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id::text, language, topic_key, title, description, enabled, sort_order, created_at, updated_at`, request.Language, request.TopicKey, request.Title, request.Description, *request.Enabled, *request.SortOrder).Scan(&view.ID, &view.Language, &view.TopicKey, &view.Title, &view.Description, &view.Enabled, &view.SortOrder, &view.CreatedAt, &view.UpdatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "topic already exists for this language"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge topic could not be created"})
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (a *app) updateKnowledgeTopic(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	var request knowledgeTopicDefinitionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request, validationError := validateKnowledgeTopicDefinition(request, true)
	if validationError != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": validationError})
		return
	}
	var view knowledgeTopicDefinitionView
	err := a.db.QueryRow(r.Context(), `UPDATE knowledge_topic_definitions SET language=$2, topic_key=$3, title=$4, description=$5, enabled=$6, sort_order=$7, updated_at=NOW()
		WHERE id=$1 RETURNING id::text, language, topic_key, title, description, enabled, sort_order, created_at, updated_at`, id, request.Language, request.TopicKey, request.Title, request.Description, *request.Enabled, *request.SortOrder).Scan(&view.ID, &view.Language, &view.TopicKey, &view.Title, &view.Description, &view.Enabled, &view.SortOrder, &view.CreatedAt, &view.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "knowledge topic not found or already exists"})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) deleteKnowledgeTopic(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	result, err := a.db.Exec(r.Context(), "DELETE FROM knowledge_topic_definitions WHERE id=$1", id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge topic could not be deleted"})
		return
	}
	if result.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "knowledge topic not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id.String()})
}

func (a *app) adminKnowledgeRebuild(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		rows, err := a.db.Query(r.Context(), `SELECT id::text, status, total_count, processed_count, failed_count, skipped_count, error, created_at, started_at, completed_at, updated_at
			FROM knowledge_rebuild_jobs ORDER BY created_at DESC LIMIT 20`)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge rebuild jobs unavailable"})
			return
		}
		defer rows.Close()
		jobs := make([]knowledgeRebuildJobView, 0, 20)
		for rows.Next() {
			job, scanErr := scanKnowledgeRebuildJob(rows)
			if scanErr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge rebuild jobs unavailable"})
				return
			}
			jobs = append(jobs, job)
		}
		writeJSON(w, http.StatusOK, jobs)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("allow", http.MethodGet+", "+http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var active knowledgeRebuildJobView
	activeRow := a.db.QueryRow(r.Context(), `SELECT id::text, status, total_count, processed_count, failed_count, skipped_count, error, created_at, started_at, completed_at, updated_at
		FROM knowledge_rebuild_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`)
	if _, err := scanKnowledgeRebuildJob(activeRow); err == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "knowledge rebuild already running", "job": active})
		return
	}
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var total int
	if err := a.db.QueryRow(r.Context(), `SELECT COUNT(*) FROM messages m JOIN wa_groups g ON g.id=m.group_id WHERE g.is_selected=TRUE`).Scan(&total); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "message count unavailable"})
		return
	}
	var view knowledgeRebuildJobView
	err := a.db.QueryRow(r.Context(), `INSERT INTO knowledge_rebuild_jobs (requested_by, total_count) VALUES ($1::uuid,$2)
		RETURNING id::text, status, total_count, processed_count, failed_count, skipped_count, error, created_at, started_at, completed_at, updated_at`, user.ID, total).
		Scan(&view.ID, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.SkippedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt, &view.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "knowledge rebuild could not be created"})
		return
	}
	event := map[string]any{"id": uuid.NewString(), "type": "knowledge.rebuild.requested", "occurredAt": time.Now().UTC(), "source": "api", "data": map[string]any{"rebuildId": view.ID, "totalCount": total}}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("knowledge.rebuild.requested", payload); err != nil {
		_, _ = a.db.Exec(r.Context(), "UPDATE knowledge_rebuild_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid", view.ID, "event bus unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "knowledge rebuild event could not be published"})
		return
	}
	writeJSON(w, http.StatusAccepted, view)
}
