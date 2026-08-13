package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type aiLearningTermView struct {
	ID             string    `json:"id"`
	GroupID        *string   `json:"groupId,omitempty"`
	GroupSubject   *string   `json:"groupSubject,omitempty"`
	GroupPlatform  *string   `json:"groupPlatform,omitempty"`
	GroupChatType  *string   `json:"groupChatType,omitempty"`
	GroupLanguage  *string   `json:"groupLanguage,omitempty"`
	Language       string    `json:"language"`
	Category       string    `json:"category"`
	TopicKey       *string   `json:"topicKey,omitempty"`
	Term           string    `json:"term"`
	Weight         float64   `json:"weight"`
	RelevanceLevel *string   `json:"relevanceLevel,omitempty"`
	Enabled        bool      `json:"enabled"`
	Source         string    `json:"source"`
	PositiveCount  int       `json:"positiveCount"`
	NegativeCount  int       `json:"negativeCount"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type aiLearningPageView struct {
	Items      []aiLearningTermView `json:"items"`
	Page       int                  `json:"page"`
	PageSize   int                  `json:"pageSize"`
	Total      int                  `json:"total"`
	TotalPages int                  `json:"totalPages"`
}

type aiLearningCategorySummaryView struct {
	Category    string `json:"category"`
	Count       int    `json:"count"`
	ActiveCount int    `json:"activeCount"`
	Learned24h  int    `json:"learned24h"`
	Learned7d   int    `json:"learned7d"`
	Learned30d  int    `json:"learned30d"`
}

type aiLearningSeriesPoint struct {
	Bucket time.Time      `json:"bucket"`
	Counts map[string]int `json:"counts"`
}

type aiLearningSummaryView struct {
	Categories []aiLearningCategorySummaryView `json:"categories"`
	Hourly     []aiLearningSeriesPoint         `json:"hourly"`
	Daily      []aiLearningSeriesPoint         `json:"daily"`
}

type aiLearningBulkRequest struct {
	IDs    []string `json:"ids"`
	Action string   `json:"action"`
}

type aiReassessmentJobView struct {
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
}

type aiLearningTermRequest struct {
	GroupID        string  `json:"groupId"`
	Language       string  `json:"language"`
	Category       string  `json:"category"`
	TopicKey       string  `json:"topicKey"`
	Term           string  `json:"term"`
	Weight         float64 `json:"weight"`
	RelevanceLevel string  `json:"relevanceLevel"`
	Enabled        *bool   `json:"enabled"`
}

var learningTokenPattern = regexp.MustCompile(`[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}`)

func normalizeLearningLanguage(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, supported := range []string{"de", "es", "ca", "en", "fr"} {
		if value == supported {
			return value
		}
	}
	return "de"
}

func normalizeLearningCategory(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, supported := range []string{"relevance", "event", "place", "keyword", "exclusion"} {
		if value == supported {
			return value
		}
	}
	return ""
}

func normalizeLearningLevel(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "high" || value == "medium" || value == "low" {
		return value
	}
	return ""
}

func (a *app) adminAILearning(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/ai-learning"), "/")
	if path == "summary" {
		a.adminAILearningSummary(w, r)
		return
	}
	if path == "reassessment" {
		a.adminAILearningReassessment(w, r)
		return
	}
	if path == "bulk" {
		a.adminAILearningBulk(w, r)
		return
	}
	if path != "" {
		if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
			w.Header().Set("allow", http.MethodPatch+", "+http.MethodDelete)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		id, err := uuid.Parse(path)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid learning term id"})
			return
		}
		if r.Method == http.MethodDelete {
			tx, err := a.db.Begin(r.Context())
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be deleted"})
				return
			}
			defer tx.Rollback(r.Context())
			if _, err = tx.Exec(r.Context(), `
				INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, source)
				SELECT id, group_id, language, category, term, 'deleted', source FROM ai_learning_terms WHERE id=$1`, id); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning history could not be stored"})
				return
			}
			result, err := tx.Exec(r.Context(), "DELETE FROM ai_learning_terms WHERE id=$1", id)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be deleted"})
				return
			}
			if result.RowsAffected() == 0 {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "learning term not found"})
				return
			}
			if err := tx.Commit(r.Context()); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be deleted"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		a.updateAILearning(w, r, id)
		return
	}
	if r.Method == http.MethodGet {
		a.listAILearning(w, r)
		return
	}
	if r.Method == http.MethodPost {
		a.createAILearning(w, r)
		return
	}
	w.Header().Set("allow", http.MethodGet+", "+http.MethodPost)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func (a *app) listAILearning(w http.ResponseWriter, r *http.Request) {
	args := []any{}
	conditions := []string{"1=1"}
	add := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if language := normalizeLearningLanguage(r.URL.Query().Get("language")); language != "" && r.URL.Query().Get("language") != "" {
		conditions = append(conditions, "t.language="+add(language))
	}
	if category := normalizeLearningCategory(r.URL.Query().Get("category")); category != "" {
		conditions = append(conditions, "t.category="+add(category))
	}
	if groupID := strings.TrimSpace(r.URL.Query().Get("groupId")); groupID != "" {
		conditions = append(conditions, "t.group_id="+add(groupID))
	}
	if search := strings.TrimSpace(r.URL.Query().Get("search")); search != "" {
		searchRunes := []rune(search)
		if len(searchRunes) > 120 {
			search = string(searchRunes[:120])
		}
		pattern := "%" + search + "%"
		conditions = append(conditions, "(t.term ILIKE "+add(pattern)+" OR COALESCE(t.topic_key,'') ILIKE "+add(pattern)+" OR COALESCE(t.source,'') ILIKE "+add(pattern)+" OR COALESCE(g.subject,'') ILIKE "+add(pattern)+" OR COALESCE(g.platform,'') ILIKE "+add(pattern)+")")
	}
	where := strings.Join(conditions, " AND ")
	countArgs := append([]any(nil), args...)
	var total int
	if err := a.db.QueryRow(r.Context(), fmt.Sprintf("SELECT COUNT(*) FROM ai_learning_terms t LEFT JOIN wa_groups g ON g.id=t.group_id WHERE %s", where), countArgs...).Scan(&total); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
		return
	}
	page := parseLearningPage(r.URL.Query().Get("page"), 1)
	pageSize := parseLearningPageSize(r.URL.Query().Get("pageSize"), 25)
	totalPages := 0
	if total > 0 {
		totalPages = (total + pageSize - 1) / pageSize
		if page > totalPages {
			page = totalPages
		}
	}
	if page < 1 {
		page = 1
	}
	queryArgs := append([]any(nil), args...)
	limitPlaceholder := addLearningArgument(&queryArgs, pageSize)
	offsetPlaceholder := addLearningArgument(&queryArgs, (page-1)*pageSize)
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT t.id::text, t.group_id, g.subject, g.platform, g.chat_type, g.language,
		       t.language, t.category, t.topic_key, t.term, t.weight, t.relevance_level,
		       t.enabled, t.source, t.positive_count, t.negative_count, t.created_at, t.updated_at
		FROM ai_learning_terms t LEFT JOIN wa_groups g ON g.id=t.group_id
		WHERE %s ORDER BY t.language, t.category, COALESCE(g.subject, ''), t.topic_key NULLS FIRST, t.term
		LIMIT %s OFFSET %s`, where, limitPlaceholder, offsetPlaceholder), queryArgs...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
		return
	}
	defer rows.Close()
	result := make([]aiLearningTermView, 0, pageSize)
	for rows.Next() {
		var item aiLearningTermView
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupSubject, &item.GroupPlatform, &item.GroupChatType, &item.GroupLanguage, &item.Language, &item.Category, &item.TopicKey, &item.Term, &item.Weight, &item.RelevanceLevel, &item.Enabled, &item.Source, &item.PositiveCount, &item.NegativeCount, &item.CreatedAt, &item.UpdatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, aiLearningPageView{Items: result, Page: page, PageSize: pageSize, Total: total, TotalPages: totalPages})
}

func learningCategoryNames() []string {
	return []string{"relevance", "event", "place", "keyword", "exclusion"}
}

func emptyLearningCounts() map[string]int {
	counts := make(map[string]int, len(learningCategoryNames()))
	for _, category := range learningCategoryNames() {
		counts[category] = 0
	}
	return counts
}

func (a *app) adminAILearningSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	view := aiLearningSummaryView{
		Categories: make([]aiLearningCategorySummaryView, 0, len(learningCategoryNames())),
		Hourly:     make([]aiLearningSeriesPoint, 0, 24),
		Daily:      make([]aiLearningSeriesPoint, 0, 30),
	}
	language := ""
	if requested := strings.TrimSpace(r.URL.Query().Get("language")); requested != "" {
		language = normalizeLearningLanguage(requested)
	}
	categoryRows, err := a.db.Query(r.Context(), `
		WITH term_counts AS (
			SELECT category, COUNT(*)::int AS term_count, COUNT(*) FILTER (WHERE enabled)::int AS active_count
			FROM ai_learning_terms WHERE ($1='' OR language=$1) GROUP BY category
		), history_counts AS (
			SELECT category,
			       COUNT(*) FILTER (WHERE occurred_at >= NOW()-INTERVAL '24 hours')::int AS learned_24h,
			       COUNT(*) FILTER (WHERE occurred_at >= NOW()-INTERVAL '7 days')::int AS learned_7d,
			       COUNT(*) FILTER (WHERE occurred_at >= NOW()-INTERVAL '30 days')::int AS learned_30d
			FROM ai_learning_term_history WHERE event_type <> 'deleted' AND ($1='' OR language=$1) GROUP BY category
		)
		SELECT tc.category, tc.term_count, tc.active_count,
		       COALESCE(hc.learned_24h,0), COALESCE(hc.learned_7d,0), COALESCE(hc.learned_30d,0)
		FROM term_counts tc LEFT JOIN history_counts hc ON hc.category=tc.category`, language)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning summary unavailable"})
		return
	}
	categorySummary := make(map[string]aiLearningCategorySummaryView, len(learningCategoryNames()))
	for _, category := range learningCategoryNames() {
		categorySummary[category] = aiLearningCategorySummaryView{Category: category}
	}
	for categoryRows.Next() {
		var item aiLearningCategorySummaryView
		if err := categoryRows.Scan(&item.Category, &item.Count, &item.ActiveCount, &item.Learned24h, &item.Learned7d, &item.Learned30d); err != nil {
			categoryRows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning summary unavailable"})
			return
		}
		categorySummary[item.Category] = item
	}
	categoryRows.Close()
	for _, category := range learningCategoryNames() {
		view.Categories = append(view.Categories, categorySummary[category])
	}

	now := time.Now().UTC()
	hourlyStart := now.Truncate(time.Hour).Add(-23 * time.Hour)
	dailyStart := now.Truncate(24 * time.Hour).Add(-29 * 24 * time.Hour)
	for bucket := hourlyStart; !bucket.After(now.Truncate(time.Hour)); bucket = bucket.Add(time.Hour) {
		view.Hourly = append(view.Hourly, aiLearningSeriesPoint{Bucket: bucket, Counts: emptyLearningCounts()})
	}
	for bucket := dailyStart; !bucket.After(now.Truncate(24 * time.Hour)); bucket = bucket.Add(24 * time.Hour) {
		view.Daily = append(view.Daily, aiLearningSeriesPoint{Bucket: bucket, Counts: emptyLearningCounts()})
	}
	hourlyIndex := make(map[string]int, len(view.Hourly))
	for index, point := range view.Hourly {
		hourlyIndex[point.Bucket.Format(time.RFC3339)] = index
	}
	dailyIndex := make(map[string]int, len(view.Daily))
	for index, point := range view.Daily {
		dailyIndex[point.Bucket.Format(time.RFC3339)] = index
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT date_trunc('hour', occurred_at) AS bucket, category, COUNT(*)::int
		FROM ai_learning_term_history
		WHERE occurred_at >= $1 AND event_type <> 'deleted' AND ($2='' OR language=$2)
		GROUP BY 1,2 ORDER BY 1`, hourlyStart, language)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning metrics unavailable"})
		return
	}
	for rows.Next() {
		var bucket time.Time
		var category string
		var count int
		if err := rows.Scan(&bucket, &category, &count); err != nil {
			rows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning metrics unavailable"})
			return
		}
		if index, ok := hourlyIndex[bucket.UTC().Format(time.RFC3339)]; ok {
			view.Hourly[index].Counts[category] = count
		}
	}
	rows.Close()
	rows, err = a.db.Query(r.Context(), `
		SELECT date_trunc('day', occurred_at) AS bucket, category, COUNT(*)::int
		FROM ai_learning_term_history
		WHERE occurred_at >= $1 AND event_type <> 'deleted' AND ($2='' OR language=$2)
		GROUP BY 1,2 ORDER BY 1`, dailyStart, language)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning metrics unavailable"})
		return
	}
	for rows.Next() {
		var bucket time.Time
		var category string
		var count int
		if err := rows.Scan(&bucket, &category, &count); err != nil {
			rows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning metrics unavailable"})
			return
		}
		if index, ok := dailyIndex[bucket.UTC().Format(time.RFC3339)]; ok {
			view.Daily[index].Counts[category] = count
		}
	}
	rows.Close()
	writeJSON(w, http.StatusOK, view)
}

func (a *app) adminAILearningBulk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var request aiLearningBulkRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	if request.Action != "delete" && request.Action != "enable" && request.Action != "disable" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be delete, enable or disable"})
		return
	}
	if len(request.IDs) == 0 || len(request.IDs) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "select between 1 and 100 learning terms"})
		return
	}
	ids := make([]uuid.UUID, 0, len(request.IDs))
	seen := map[uuid.UUID]struct{}{}
	for _, value := range request.IDs {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid learning term id"})
			return
		}
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "bulk operation could not start"})
		return
	}
	defer tx.Rollback(r.Context())
	if request.Action == "delete" {
		if _, err = tx.Exec(r.Context(), `
			INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, source)
			SELECT id, group_id, language, category, term, 'deleted', source
			FROM ai_learning_terms WHERE id = ANY($1::uuid[])`, ids); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "bulk history could not be stored"})
			return
		}
	}
	var resultTag interface{ RowsAffected() int64 }
	if request.Action == "delete" {
		resultTag, err = tx.Exec(r.Context(), "DELETE FROM ai_learning_terms WHERE id = ANY($1::uuid[])", ids)
	} else {
		enabled := request.Action == "enable"
		resultTag, err = tx.Exec(r.Context(), `
			UPDATE ai_learning_terms SET enabled=$1, source='admin', updated_at=NOW()
			WHERE id = ANY($2::uuid[])`, enabled, ids)
		if err == nil {
			_, err = tx.Exec(r.Context(), `
				INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, source)
				SELECT id, group_id, language, category, term, 'admin_update', 'admin'
				FROM ai_learning_terms WHERE id = ANY($1::uuid[])`, ids)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "bulk operation failed"})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "bulk operation could not be committed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "affected": resultTag.RowsAffected()})
}

func parseLearningPage(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

func parseLearningPageSize(value string, fallback int) int {
	parsed := parseLearningPage(value, fallback)
	if parsed > 100 {
		return 100
	}
	if parsed < 10 {
		return 10
	}
	return parsed
}

func addLearningArgument(args *[]any, value any) string {
	*args = append(*args, value)
	return fmt.Sprintf("$%d", len(*args))
}

func scanAILearningReassessmentJob(row interface{ Scan(...any) error }) (aiReassessmentJobView, error) {
	var view aiReassessmentJobView
	err := row.Scan(&view.ID, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.SkippedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt)
	return view, err
}

func (a *app) adminAILearningReassessment(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		rows, err := a.db.Query(r.Context(), `
			SELECT id::text, status, total_count, processed_count, failed_count, skipped_count,
			       error, created_at, started_at, completed_at
			FROM ai_reassessment_jobs ORDER BY created_at DESC LIMIT 20`)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "reassessment jobs unavailable"})
			return
		}
		defer rows.Close()
		jobs := make([]aiReassessmentJobView, 0, 20)
		for rows.Next() {
			job, scanErr := scanAILearningReassessmentJob(rows)
			if scanErr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "reassessment jobs unavailable"})
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
	var active aiReassessmentJobView
	activeRow := a.db.QueryRow(r.Context(), `
		SELECT id::text, status, total_count, processed_count, failed_count, skipped_count,
		       error, created_at, started_at, completed_at
		FROM ai_reassessment_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`)
	if _, err := scanAILearningReassessmentJob(activeRow); err == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "reassessment already running", "job": active})
		return
	}
	var total int
	if err := a.db.QueryRow(r.Context(), `SELECT COUNT(*) FROM messages m JOIN wa_groups g ON g.id=m.group_id`).Scan(&total); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "message count unavailable"})
		return
	}
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var view aiReassessmentJobView
	err := a.db.QueryRow(r.Context(), `
		INSERT INTO ai_reassessment_jobs (requested_by, total_count)
		VALUES ($1::uuid,$2)
		RETURNING id::text, status, total_count, processed_count, failed_count, skipped_count,
		          error, created_at, started_at, completed_at`, user.ID, total).
		Scan(&view.ID, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.SkippedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "reassessment could not be created"})
		return
	}
	event := map[string]any{
		"id": uuid.NewString(), "type": "ai.reassessment.requested", "occurredAt": time.Now().UTC(), "source": "api",
		"data": map[string]any{"reassessmentId": view.ID, "totalCount": total},
	}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("ai.reassessment.requested", payload); err != nil {
		_, _ = a.db.Exec(r.Context(), "UPDATE ai_reassessment_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid", view.ID, "event bus unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "reassessment event could not be published"})
		return
	}
	writeJSON(w, http.StatusAccepted, view)
}

func validateAILearningRequest(request aiLearningTermRequest) (aiLearningTermRequest, error) {
	request.Language = normalizeLearningLanguage(request.Language)
	request.Category = normalizeLearningCategory(request.Category)
	request.GroupID = strings.TrimSpace(request.GroupID)
	request.TopicKey = strings.TrimSpace(request.TopicKey)
	request.Term = strings.TrimSpace(request.Term)
	request.RelevanceLevel = normalizeLearningLevel(request.RelevanceLevel)
	if request.Category == "" || request.Term == "" || len(request.Term) > 160 {
		return request, fmt.Errorf("category and term are required")
	}
	if request.Category == "keyword" && request.TopicKey == "" {
		return request, fmt.Errorf("topicKey is required for keyword terms")
	}
	if request.Category != "relevance" && request.RelevanceLevel != "" {
		return request, fmt.Errorf("relevanceLevel is only valid for relevance terms")
	}
	if request.Weight < -10 || request.Weight > 10 {
		return request, fmt.Errorf("weight must be between -10 and 10")
	}
	return request, nil
}

func (a *app) createAILearning(w http.ResponseWriter, r *http.Request) {
	var request aiLearningTermRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request, err := validateAILearningRequest(request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if request.GroupID != "" {
		var exists bool
		if err := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM wa_groups WHERE id=$1)", request.GroupID).Scan(&exists); err != nil || !exists {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "group not found"})
			return
		}
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	var id string
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO ai_learning_terms (group_id, language, category, topic_key, term, weight, relevance_level, enabled, source)
		VALUES (NULLIF($1,''),$2,$3,NULLIF($4,''),$5,$6,NULLIF($7,''),$8,'admin') RETURNING id::text`,
		request.GroupID, request.Language, request.Category, request.TopicKey, request.Term, request.Weight, request.RelevanceLevel, enabled).Scan(&id)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "learning term already exists"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be created"})
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, weight_delta, source)
		SELECT id, group_id, language, category, term, 'created', weight, source
		FROM ai_learning_terms WHERE id=$1::uuid`, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning history could not be stored"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (a *app) updateAILearning(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	var request aiLearningTermRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	request, err := validateAILearningRequest(request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	result, err := a.db.Exec(r.Context(), `
		UPDATE ai_learning_terms SET group_id=NULLIF($2,''), language=$3, category=$4, topic_key=NULLIF($5,''), term=$6,
		weight=$7, relevance_level=NULLIF($8,''), enabled=$9, source='admin', updated_at=NOW() WHERE id=$1`,
		id, request.GroupID, request.Language, request.Category, request.TopicKey, request.Term, request.Weight, request.RelevanceLevel, enabled)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be updated"})
		return
	}
	if result.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "learning term not found"})
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, source)
		SELECT id, group_id, language, category, term, 'admin_update', source
		FROM ai_learning_terms WHERE id=$1`, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning history could not be stored"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func learningTokens(text string, stopwords map[string]struct{}) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0)
	for _, raw := range learningTokenPattern.FindAllString(strings.ToLower(text), -1) {
		term := strings.Trim(raw, "'’-_")
		if len([]rune(term)) < 3 || strings.Trim(term, "0123456789") == "" {
			continue
		}
		if _, stop := stopwords[term]; stop {
			continue
		}
		if _, exists := seen[term]; exists {
			continue
		}
		seen[term] = struct{}{}
		result = append(result, term)
	}
	return result
}

func feedbackLearningDelta(targetType, decision, level string) float64 {
	if targetType == "relevance" {
		switch level {
		case "high":
			return 0.30
		case "medium":
			return 0.14
		case "low":
			return -0.30
		}
	}
	if decision == "accept" {
		return 0.30
	}
	if decision == "reject" {
		return -0.30
	}
	return 0
}

func (a *app) recordAILearningFeedback(ctx context.Context, groupID, messageID, targetType, decision string, correction map[string]any) error {
	if targetType != "relevance" && targetType != "event" && targetType != "place" {
		return nil
	}
	var language, text string
	if err := a.db.QueryRow(ctx, `SELECT COALESCE(g.language,'de'), COALESCE(m.text,'') FROM messages m JOIN wa_groups g ON g.id=m.group_id WHERE m.id=$1::uuid`, messageID).Scan(&language, &text); err != nil {
		return err
	}
	language = normalizeLearningLanguage(language)
	stopwords := make(map[string]struct{})
	if rows, err := a.db.Query(ctx, `SELECT term FROM ai_learning_terms WHERE language=$1 AND category='exclusion' AND enabled=TRUE AND (group_id IS NULL OR group_id=$2)`, language, groupID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var term string
			if rows.Scan(&term) == nil {
				stopwords[strings.ToLower(strings.TrimSpace(term))] = struct{}{}
			}
		}
	}
	level, _ := correction["relevanceLevel"].(string)
	level = normalizeLearningLevel(level)
	delta := feedbackLearningDelta(targetType, decision, level)
	if delta == 0 {
		return nil
	}
	for _, term := range learningTokens(text, stopwords) {
		positive, negative := 0, 0
		if delta > 0 {
			positive = 1
		} else {
			negative = 1
		}
		result, err := a.db.Exec(ctx, `
			INSERT INTO ai_learning_terms (group_id, language, category, term, weight, relevance_level, source, positive_count, negative_count)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),'feedback',$7,$8)
			ON CONFLICT DO NOTHING`, groupID, language, targetType, term, delta, level, positive, negative)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			// An existing row is updated using the same normalized scope.
			_, updateErr := a.db.Exec(ctx, `
				UPDATE ai_learning_terms SET weight=GREATEST(-10, LEAST(10, weight+$5)),
				positive_count=positive_count+$6, negative_count=negative_count+$7, source='feedback', updated_at=NOW()
				WHERE group_id=$1 AND language=$2 AND category=$3 AND lower(term)=lower($4)`, groupID, language, targetType, term, delta, positive, negative)
			if updateErr != nil {
				return updateErr
			}
		}
		if _, historyErr := a.db.Exec(ctx, `
			INSERT INTO ai_learning_term_history (term_id, group_id, language, category, term, event_type, weight_delta, source)
			SELECT id, group_id, language, category, term, 'feedback', $5, 'feedback'
			FROM ai_learning_terms
			WHERE group_id=$1 AND language=$2 AND category=$3 AND lower(term)=lower($4)`, groupID, language, targetType, term, delta); historyErr != nil {
			return historyErr
		}
	}
	return nil
}
