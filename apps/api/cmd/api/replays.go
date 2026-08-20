package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

type replayRequest struct {
	GroupIDs     []string `json:"groupIds"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	IncludeMedia *bool    `json:"includeMedia"`
}

type replayJobView struct {
	ID             string     `json:"id"`
	GroupIDs       []string   `json:"groupIds"`
	From           time.Time  `json:"from"`
	To             time.Time  `json:"to"`
	IncludeMedia   bool       `json:"includeMedia"`
	Status         string     `json:"status"`
	TotalCount     int        `json:"totalCount"`
	ProcessedCount int        `json:"processedCount"`
	FailedCount    int        `json:"failedCount"`
	Error          *string    `json:"error,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	CompletedAt    *time.Time `json:"completedAt,omitempty"`
}

func parseReplayTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if len(value) == len("2006-01-02") {
		return time.ParseInLocation("2006-01-02", value, time.UTC)
	}
	return time.Parse(time.RFC3339, value)
}

func scanReplayJob(row interface{ Scan(...any) error }) (replayJobView, error) {
	var view replayJobView
	var groupIDsJSON []byte
	err := row.Scan(&view.ID, &groupIDsJSON, &view.From, &view.To, &view.IncludeMedia, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt)
	if err == nil {
		if unmarshalErr := json.Unmarshal(groupIDsJSON, &view.GroupIDs); unmarshalErr != nil {
			return view, unmarshalErr
		}
	}
	return view, err
}

// replays lists and creates replay/backfill jobs for selected groups.
// @Summary List or create replay jobs
// @Tags replays
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param all query bool false "Administrators may include all users' jobs"
// @Param body body replayRequest true "Replay range and groups"
// @Success 200 {array} replayJobView
// @Success 202 {object} replayJobView
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Router /replays [get]
func (a *app) replays(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		where := "requested_by=$1::uuid"
		args := []any{user.ID}
		if user.isAdmin() && r.URL.Query().Get("all") == "true" {
			where = "TRUE"
			args = nil
		}
		rows, err := a.db.Query(r.Context(), `
			SELECT id::text, group_ids, from_at, to_at, include_media, status,
			       total_count, processed_count, failed_count, error, created_at, started_at, completed_at
			FROM replay_jobs WHERE `+where+` ORDER BY created_at DESC LIMIT 100`, args...)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "replay jobs unavailable"})
			return
		}
		defer rows.Close()
		result := make([]replayJobView, 0)
		for rows.Next() {
			item, scanErr := scanReplayJob(rows)
			if scanErr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "replay jobs unavailable"})
				return
			}
			result = append(result, item)
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var request replayRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	from, fromErr := parseReplayTime(request.From)
	to, toErr := parseReplayTime(request.To)
	if fromErr != nil || toErr != nil || !to.After(from) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "from and to must be valid timestamps and to must be after from"})
		return
	}
	if to.Sub(from) > 366*24*time.Hour {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "replay range may not exceed 366 days"})
		return
	}
	includeMedia := true
	if request.IncludeMedia != nil {
		includeMedia = *request.IncludeMedia
	}

	requestedIDs := make([]string, 0, len(request.GroupIDs))
	for _, groupID := range request.GroupIDs {
		if strings.TrimSpace(groupID) != "" {
			requestedIDs = append(requestedIDs, strings.TrimSpace(groupID))
		}
	}
	args := make([]any, 0, 2)
	conditions := []string{groupReadCondition(user, "g", &args), groupSelectedCondition(user, "g", &args)}
	if len(requestedIDs) > 0 {
		args = append(args, requestedIDs)
		conditions = append(conditions, "g.id = ANY($"+itoa(len(args))+"::text[])")
	}
	rows, err := a.db.Query(r.Context(), "SELECT g.id FROM wa_groups g WHERE "+strings.Join(conditions, " AND "), args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "groups unavailable"})
		return
	}
	groupIDs := make([]string, 0)
	for rows.Next() {
		var groupID string
		if scanErr := rows.Scan(&groupID); scanErr != nil {
			rows.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "groups unavailable"})
			return
		}
		groupIDs = append(groupIDs, groupID)
	}
	rows.Close()
	if len(groupIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no selected groups available for replay"})
		return
	}
	groupIDsJSON, _ := json.Marshal(groupIDs)
	var view replayJobView
	var groupIDsStored []byte
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO replay_jobs (requested_by, group_ids, from_at, to_at, include_media)
		VALUES ($1::uuid,$2::jsonb,$3,$4,$5)
		RETURNING id::text, group_ids, from_at, to_at, include_media, status, total_count,
		          processed_count, failed_count, error, created_at, started_at, completed_at`,
		user.ID, groupIDsJSON, from.UTC(), to.UTC(), includeMedia).
		Scan(&view.ID, &groupIDsStored, &view.From, &view.To, &view.IncludeMedia, &view.Status, &view.TotalCount, &view.ProcessedCount, &view.FailedCount, &view.Error, &view.CreatedAt, &view.StartedAt, &view.CompletedAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "replay could not be created"})
		return
	}
	_ = json.Unmarshal(groupIDsStored, &view.GroupIDs)
	event := map[string]any{
		"id": uuid.NewString(), "type": "replay.requested", "occurredAt": time.Now().UTC(), "source": "api",
		"data": map[string]any{"replayId": view.ID, "groupIds": groupIDs, "fromAt": from.UTC().Format(time.RFC3339), "toAt": to.UTC().Format(time.RFC3339), "includeMedia": includeMedia},
	}
	payload, _ := json.Marshal(event)
	if _, err := a.js.Publish("replay.requested", payload); err != nil {
		_, _ = a.db.Exec(r.Context(), "UPDATE replay_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid", view.ID, "event bus unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "replay event could not be published"})
		return
	}
	writeJSON(w, http.StatusAccepted, view)
}
