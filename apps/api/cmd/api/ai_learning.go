package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

type aiLearningTermView struct {
	ID             string  `json:"id"`
	GroupID        *string `json:"groupId,omitempty"`
	GroupSubject   *string `json:"groupSubject,omitempty"`
	Language       string  `json:"language"`
	Category       string  `json:"category"`
	TopicKey       *string `json:"topicKey,omitempty"`
	Term           string  `json:"term"`
	Weight         float64 `json:"weight"`
	RelevanceLevel *string `json:"relevanceLevel,omitempty"`
	Enabled        bool    `json:"enabled"`
	Source         string  `json:"source"`
	PositiveCount  int     `json:"positiveCount"`
	NegativeCount  int     `json:"negativeCount"`
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
			result, err := a.db.Exec(r.Context(), "DELETE FROM ai_learning_terms WHERE id=$1", id)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning term could not be deleted"})
				return
			}
			if result.RowsAffected() == 0 {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "learning term not found"})
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
	rows, err := a.db.Query(r.Context(), fmt.Sprintf(`
		SELECT t.id::text, t.group_id, g.subject, t.language, t.category, t.topic_key, t.term,
		       t.weight, t.relevance_level, t.enabled, t.source, t.positive_count, t.negative_count
		FROM ai_learning_terms t LEFT JOIN wa_groups g ON g.id=t.group_id
		WHERE %s ORDER BY t.language, t.category, COALESCE(g.subject, ''), t.topic_key NULLS FIRST, t.term`, strings.Join(conditions, " AND ")), args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
		return
	}
	defer rows.Close()
	result := make([]aiLearningTermView, 0)
	for rows.Next() {
		var item aiLearningTermView
		if err := rows.Scan(&item.ID, &item.GroupID, &item.GroupSubject, &item.Language, &item.Category, &item.TopicKey, &item.Term, &item.Weight, &item.RelevanceLevel, &item.Enabled, &item.Source, &item.PositiveCount, &item.NegativeCount); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "learning terms unavailable"})
			return
		}
		result = append(result, item)
	}
	writeJSON(w, http.StatusOK, result)
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
	}
	return nil
}
