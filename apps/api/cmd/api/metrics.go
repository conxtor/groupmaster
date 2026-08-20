package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// apiInstrumentation contains process-local HTTP counters. Database, NATS,
// connector and job figures are collected from their durable sources below.
type apiInstrumentation struct {
	startedAt      time.Time
	requests       atomic.Uint64
	errorResponses atomic.Uint64
	inFlight       atomic.Int64
	durationNanos  atomic.Uint64
	status2xx      atomic.Uint64
	status3xx      atomic.Uint64
	status4xx      atomic.Uint64
	status5xx      atomic.Uint64
}

func newAPIInstrumentation() *apiInstrumentation {
	return &apiInstrumentation{startedAt: time.Now().UTC()}
}

type metricsResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *metricsResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *metricsResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *metricsResponseWriter) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (a *app) instrumentHTTP(next http.Handler) http.Handler {
	if a.instrumentation == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		a.instrumentation.inFlight.Add(1)
		wrapped := &metricsResponseWriter{ResponseWriter: w}
		defer func() {
			status := wrapped.status
			if status == 0 {
				status = http.StatusOK
			}
			a.instrumentation.requests.Add(1)
			a.instrumentation.durationNanos.Add(uint64(time.Since(started)))
			a.instrumentation.inFlight.Add(-1)
			switch {
			case status >= 500:
				a.instrumentation.status5xx.Add(1)
				a.instrumentation.errorResponses.Add(1)
			case status >= 400:
				a.instrumentation.status4xx.Add(1)
				a.instrumentation.errorResponses.Add(1)
			case status >= 300:
				a.instrumentation.status3xx.Add(1)
			default:
				a.instrumentation.status2xx.Add(1)
			}
		}()
		next.ServeHTTP(wrapped, r)
	})
}

type prometheusStatusFamily struct {
	metric string
	help   string
	query  string
	source string
}

func writePrometheusHeader(w http.ResponseWriter, metric, help, metricType string) {
	fmt.Fprintf(w, "# HELP %s %s\n", metric, help)
	fmt.Fprintf(w, "# TYPE %s %s\n", metric, metricType)
}

func writePrometheusGauge(w http.ResponseWriter, metric string, value any) {
	fmt.Fprintf(w, "%s %v\n", metric, value)
}

func writePrometheusLabeledGauge(w http.ResponseWriter, metric, labels string, value any) {
	fmt.Fprintf(w, "%s{%s} %v\n", metric, labels, value)
}

func prometheusLabel(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return strings.ReplaceAll(value, "\n", `\n`)
}

func (a *app) emitStatusFamily(ctx context.Context, w http.ResponseWriter, family prometheusStatusFamily) bool {
	writePrometheusHeader(w, family.metric, family.help, "gauge")
	rows, err := a.db.Query(ctx, family.query)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return false
		}
		writePrometheusLabeledGauge(w, family.metric, fmt.Sprintf("status=\"%s\"", prometheusLabel(status)), count)
	}
	return rows.Err() == nil
}

func (a *app) emitLabelFamily(ctx context.Context, w http.ResponseWriter, metric, help, labelName, query string) bool {
	writePrometheusHeader(w, metric, help, "gauge")
	rows, err := a.db.Query(ctx, query)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var label string
		var count int64
		if err := rows.Scan(&label, &count); err != nil {
			return false
		}
		writePrometheusLabeledGauge(w, metric, fmt.Sprintf("%s=\"%s\"", labelName, prometheusLabel(label)), count)
	}
	return rows.Err() == nil
}

// metrics exposes API and dependency statistics in Prometheus text format.
// @Summary Get API metrics
// @Tags system
// @Produce plain
// @Success 200 {string} string
// @Router /metrics [get]
func (a *app) metrics(w http.ResponseWriter, r *http.Request) {
	scrapeStarted := time.Now()
	w.Header().Set("content-type", "text/plain; version=0.0.4")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)

	writePrometheusHeader(w, "wagi_api_up", "API process health", "gauge")
	writePrometheusGauge(w, "wagi_api_up", 1)
	if a.instrumentation != nil {
		writePrometheusHeader(w, "wagi_api_start_time_seconds", "Unix timestamp when the API process started", "gauge")
		writePrometheusGauge(w, "wagi_api_start_time_seconds", a.instrumentation.startedAt.Unix())
		writePrometheusHeader(w, "wagi_api_uptime_seconds", "API process uptime in seconds", "gauge")
		writePrometheusGauge(w, "wagi_api_uptime_seconds", time.Since(a.instrumentation.startedAt).Seconds())
		writePrometheusHeader(w, "wagi_api_http_requests_total", "HTTP requests handled by the API process", "counter")
		writePrometheusGauge(w, "wagi_api_http_requests_total", a.instrumentation.requests.Load())
		writePrometheusHeader(w, "wagi_api_http_error_responses_total", "HTTP responses with a 4xx or 5xx status", "counter")
		writePrometheusGauge(w, "wagi_api_http_error_responses_total", a.instrumentation.errorResponses.Load())
		writePrometheusHeader(w, "wagi_api_http_requests_in_flight", "HTTP requests currently being handled", "gauge")
		writePrometheusGauge(w, "wagi_api_http_requests_in_flight", a.instrumentation.inFlight.Load())
		writePrometheusHeader(w, "wagi_api_http_request_duration_seconds", "Cumulative HTTP request duration", "summary")
		writePrometheusGauge(w, "wagi_api_http_request_duration_seconds_sum", float64(a.instrumentation.durationNanos.Load())/float64(time.Second))
		writePrometheusGauge(w, "wagi_api_http_request_duration_seconds_count", a.instrumentation.requests.Load())
		writePrometheusHeader(w, "wagi_api_http_responses_total", "HTTP responses grouped by status class", "counter")
		writePrometheusLabeledGauge(w, "wagi_api_http_responses_total", `status_class="2xx"`, a.instrumentation.status2xx.Load())
		writePrometheusLabeledGauge(w, "wagi_api_http_responses_total", `status_class="3xx"`, a.instrumentation.status3xx.Load())
		writePrometheusLabeledGauge(w, "wagi_api_http_responses_total", `status_class="4xx"`, a.instrumentation.status4xx.Load())
		writePrometheusLabeledGauge(w, "wagi_api_http_responses_total", `status_class="5xx"`, a.instrumentation.status5xx.Load())
	}

	dbStat := a.db.Stat()
	writePrometheusHeader(w, "wagi_api_database_up", "PostgreSQL connectivity", "gauge")
	databaseUp := int64(0)
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if a.db != nil {
		if err := a.db.Ping(ctx); err == nil {
			databaseUp = 1
		}
	}
	writePrometheusGauge(w, "wagi_api_database_up", databaseUp)
	writePrometheusHeader(w, "wagi_api_database_pool_connections", "PostgreSQL connection pool state", "gauge")
	writePrometheusLabeledGauge(w, "wagi_api_database_pool_connections", `state="max"`, dbStat.MaxConns())
	writePrometheusLabeledGauge(w, "wagi_api_database_pool_connections", `state="total"`, dbStat.TotalConns())
	writePrometheusLabeledGauge(w, "wagi_api_database_pool_connections", `state="idle"`, dbStat.IdleConns())
	writePrometheusLabeledGauge(w, "wagi_api_database_pool_connections", `state="acquired"`, dbStat.AcquiredConns())
	writePrometheusLabeledGauge(w, "wagi_api_database_pool_connections", `state="constructing"`, dbStat.ConstructingConns())
	writePrometheusHeader(w, "wagi_api_database_pool_acquires_total", "Successful PostgreSQL pool acquires", "counter")
	writePrometheusGauge(w, "wagi_api_database_pool_acquires_total", dbStat.AcquireCount())
	writePrometheusHeader(w, "wagi_api_database_pool_empty_acquires_total", "Pool acquires that waited for a connection", "counter")
	writePrometheusGauge(w, "wagi_api_database_pool_empty_acquires_total", dbStat.EmptyAcquireCount())
	writePrometheusHeader(w, "wagi_api_database_pool_canceled_acquires_total", "Canceled PostgreSQL pool acquires", "counter")
	writePrometheusGauge(w, "wagi_api_database_pool_canceled_acquires_total", dbStat.CanceledAcquireCount())
	writePrometheusHeader(w, "wagi_api_database_pool_acquire_duration_seconds_total", "Cumulative PostgreSQL pool acquire duration", "counter")
	writePrometheusGauge(w, "wagi_api_database_pool_acquire_duration_seconds_total", dbStat.AcquireDuration().Seconds())

	queryFailures := make([]string, 0)
	if databaseUp == 1 {
		var groups, selectedGroups, messages, recentMessages24h, recentMessages7d int64
		var analyses, relevantAnalyses, mediaMessages, failures, recentFailures24h, lastMessageUnix int64
		err := a.db.QueryRow(ctx, `
			SELECT
				(SELECT COUNT(*) FROM wa_groups),
				(SELECT COUNT(*) FROM wa_groups WHERE is_selected),
				(SELECT COUNT(*) FROM messages),
				(SELECT COUNT(*) FROM messages WHERE received_at >= NOW() - INTERVAL '24 hours'),
				(SELECT COUNT(*) FROM messages WHERE received_at >= NOW() - INTERVAL '7 days'),
				(SELECT COUNT(*) FROM message_analyses),
				(SELECT COUNT(*) FROM message_analyses WHERE relevant),
				(SELECT COUNT(*) FROM messages WHERE has_media),
				(SELECT COUNT(*) FROM event_failures),
				(SELECT COUNT(*) FROM event_failures WHERE created_at >= NOW() - INTERVAL '24 hours'),
				COALESCE(EXTRACT(EPOCH FROM (SELECT MAX(received_at) FROM messages)),0)::bigint
			`).Scan(&groups, &selectedGroups, &messages, &recentMessages24h, &recentMessages7d, &analyses, &relevantAnalyses, &mediaMessages, &failures, &recentFailures24h, &lastMessageUnix)
		if err != nil {
			queryFailures = append(queryFailures, "api_summary")
		} else {
			writePrometheusHeader(w, "wagi_api_groups_total", "Known groups", "gauge")
			writePrometheusGauge(w, "wagi_api_groups_total", groups)
			writePrometheusHeader(w, "wagi_api_selected_groups_total", "Selected groups", "gauge")
			writePrometheusGauge(w, "wagi_api_selected_groups_total", selectedGroups)
			writePrometheusHeader(w, "wagi_api_messages_total", "Stored messages", "gauge")
			writePrometheusGauge(w, "wagi_api_messages_total", messages)
			writePrometheusHeader(w, "wagi_api_recent_messages_total", "Stored messages in the selected time window", "gauge")
			writePrometheusLabeledGauge(w, "wagi_api_recent_messages_total", `window="24h"`, recentMessages24h)
			writePrometheusLabeledGauge(w, "wagi_api_recent_messages_total", `window="7d"`, recentMessages7d)
			writePrometheusHeader(w, "wagi_api_message_analyses_total", "Stored message analyses", "gauge")
			writePrometheusLabeledGauge(w, "wagi_api_message_analyses_total", `state="all"`, analyses)
			writePrometheusLabeledGauge(w, "wagi_api_message_analyses_total", `state="relevant"`, relevantAnalyses)
			writePrometheusHeader(w, "wagi_api_messages_with_media_total", "Stored messages containing media", "gauge")
			writePrometheusGauge(w, "wagi_api_messages_with_media_total", mediaMessages)
			writePrometheusHeader(w, "wagi_api_processing_failures_total", "Recorded processing failures", "gauge")
			writePrometheusLabeledGauge(w, "wagi_api_processing_failures_total", `window="all"`, failures)
			writePrometheusLabeledGauge(w, "wagi_api_processing_failures_total", `window="24h"`, recentFailures24h)
			writePrometheusHeader(w, "wagi_api_last_message_timestamp_seconds", "Unix timestamp of the latest stored message", "gauge")
			writePrometheusGauge(w, "wagi_api_last_message_timestamp_seconds", lastMessageUnix)
		}

		families := []prometheusStatusFamily{
			{metric: "wagi_api_audio_jobs", help: "Audio jobs by status", query: `SELECT status, COUNT(*)::bigint FROM audio_jobs GROUP BY status ORDER BY status`, source: "audio_jobs"},
			{metric: "wagi_api_ai_jobs", help: "AI jobs by status", query: `SELECT status, COUNT(*)::bigint FROM ai_jobs GROUP BY status ORDER BY status`, source: "ai_jobs"},
			{metric: "wagi_api_media_objects", help: "Media objects by status", query: `SELECT status, COUNT(*)::bigint FROM media_objects GROUP BY status ORDER BY status`, source: "media_objects"},
			{metric: "wagi_api_event_inbox", help: "Inbox events by status", query: `SELECT status, COUNT(*)::bigint FROM event_inbox GROUP BY status ORDER BY status`, source: "event_inbox"},
			{metric: "wagi_api_replay_jobs", help: "Replay jobs by status", query: `SELECT status, COUNT(*)::bigint FROM replay_jobs GROUP BY status ORDER BY status`, source: "replay_jobs"},
		}
		for _, family := range families {
			if !a.emitStatusFamily(ctx, w, family) {
				queryFailures = append(queryFailures, family.source)
			}
		}
		labelFamilies := []struct {
			metric, help, label, query, source string
		}{
			{"wagi_api_groups_by_platform_total", "Known groups by platform", "platform", `SELECT platform, COUNT(*)::bigint FROM wa_groups GROUP BY platform ORDER BY platform`, "groups_by_platform"},
			{"wagi_api_selected_groups_by_platform_total", "Selected groups by platform", "platform", `SELECT platform, COUNT(*)::bigint FROM wa_groups WHERE is_selected GROUP BY platform ORDER BY platform`, "selected_groups_by_platform"},
			{"wagi_api_messages_by_kind_total", "Stored messages by kind", "kind", `SELECT kind, COUNT(*)::bigint FROM messages GROUP BY kind ORDER BY kind`, "messages_by_kind"},
			{"wagi_api_message_analyses_by_relevance_total", "Message analyses by relevance level", "relevance_level", `SELECT COALESCE(relevance_level,'unknown'), COUNT(*)::bigint FROM message_analyses GROUP BY 1 ORDER BY 1`, "analyses_by_relevance"},
			{"wagi_api_connector_accounts", "Connector accounts by platform and status", "platform_status", `SELECT platform || ':' || status, COUNT(*)::bigint FROM connector_accounts GROUP BY platform, status ORDER BY platform, status`, "connector_accounts"},
			{"wagi_api_connector_leases", "Active connector leases by platform and kind", "platform_kind", `SELECT ca.platform || ':' || COALESCE(cl.lease_kind,'processing'), COUNT(*)::bigint FROM connector_leases cl JOIN connector_accounts ca ON ca.id=cl.account_id WHERE cl.lease_until > NOW() GROUP BY ca.platform, cl.lease_kind ORDER BY ca.platform, cl.lease_kind`, "connector_leases"},
			{"wagi_api_connector_onboarding_requests", "Connector onboarding requests by platform and status", "platform_status", `SELECT platform || ':' || status, COUNT(*)::bigint FROM connector_onboarding_requests GROUP BY platform, status ORDER BY platform, status`, "connector_onboarding_requests"},
		}
		for _, family := range labelFamilies {
			if !a.emitLabelFamily(ctx, w, family.metric, family.help, family.label, family.query) {
				queryFailures = append(queryFailures, family.source)
			}
		}

		var cursorCount, pendingCursorCount int64
		if err := a.db.QueryRow(ctx, `SELECT COUNT(*), COUNT(*) FILTER (WHERE last_received_at IS NULL) FROM connector_cursors`).Scan(&cursorCount, &pendingCursorCount); err != nil {
			queryFailures = append(queryFailures, "connector_cursors")
		} else {
			writePrometheusHeader(w, "wagi_api_connector_cursors", "Connector receive cursors", "gauge")
			writePrometheusLabeledGauge(w, "wagi_api_connector_cursors", `state="total"`, cursorCount)
			writePrometheusLabeledGauge(w, "wagi_api_connector_cursors", `state="without_message_timestamp"`, pendingCursorCount)
		}

		var mediaBytes int64
		if err := a.db.QueryRow(ctx, `SELECT COALESCE(SUM(bytes),0)::bigint FROM media_objects WHERE status='completed'`).Scan(&mediaBytes); err != nil {
			queryFailures = append(queryFailures, "media_bytes")
		} else {
			writePrometheusHeader(w, "wagi_api_media_bytes", "Completed media object bytes", "gauge")
			writePrometheusGauge(w, "wagi_api_media_bytes", mediaBytes)
		}
	}

	writePrometheusHeader(w, "wagi_api_nats_connected", "NATS connection state", "gauge")
	natsConnected := int64(0)
	if a.nc != nil && a.nc.IsConnected() {
		natsConnected = 1
	}
	writePrometheusGauge(w, "wagi_api_nats_connected", natsConnected)
	writePrometheusHeader(w, "wagi_api_nats_messages_total", "NATS message traffic since API start", "counter")
	writePrometheusHeader(w, "wagi_api_nats_bytes_total", "NATS byte traffic since API start", "counter")
	writePrometheusHeader(w, "wagi_api_nats_reconnects_total", "NATS reconnects since API start", "counter")
	if a.nc != nil {
		stats := a.nc.Stats()
		writePrometheusLabeledGauge(w, "wagi_api_nats_messages_total", `direction="in"`, stats.InMsgs)
		writePrometheusLabeledGauge(w, "wagi_api_nats_messages_total", `direction="out"`, stats.OutMsgs)
		writePrometheusLabeledGauge(w, "wagi_api_nats_bytes_total", `direction="in"`, stats.InBytes)
		writePrometheusLabeledGauge(w, "wagi_api_nats_bytes_total", `direction="out"`, stats.OutBytes)
		writePrometheusGauge(w, "wagi_api_nats_reconnects_total", stats.Reconnects)
	} else {
		writePrometheusLabeledGauge(w, "wagi_api_nats_messages_total", `direction="in"`, 0)
		writePrometheusLabeledGauge(w, "wagi_api_nats_messages_total", `direction="out"`, 0)
		writePrometheusLabeledGauge(w, "wagi_api_nats_bytes_total", `direction="in"`, 0)
		writePrometheusLabeledGauge(w, "wagi_api_nats_bytes_total", `direction="out"`, 0)
		writePrometheusGauge(w, "wagi_api_nats_reconnects_total", 0)
	}

	writePrometheusHeader(w, "wagi_api_jetstream_stream_info", "JetStream stream availability", "gauge")
	writePrometheusHeader(w, "wagi_api_jetstream_stream_messages", "Messages stored in JetStream streams", "gauge")
	writePrometheusHeader(w, "wagi_api_jetstream_stream_bytes", "Bytes stored in JetStream streams", "gauge")
	writePrometheusHeader(w, "wagi_api_jetstream_consumer_pending", "Pending messages for JetStream consumers", "gauge")
	writePrometheusHeader(w, "wagi_api_jetstream_consumer_ack_pending", "Acknowledgements pending for JetStream consumers", "gauge")
	if a.js != nil {
		streamNames := []string{"WAGI_EVENTS", "WAGI_DLQ", "WAGI_REASSESSMENT", "WAGI_THREAD_REASSESSMENT", "WAGI_KB_REBUILD"}
		for _, streamName := range streamNames {
			info, err := a.js.StreamInfo(streamName)
			streamLabel := fmt.Sprintf(`stream="%s"`, prometheusLabel(streamName))
			if err != nil {
				writePrometheusLabeledGauge(w, "wagi_api_jetstream_stream_info", streamLabel, 0)
				continue
			}
			writePrometheusLabeledGauge(w, "wagi_api_jetstream_stream_info", streamLabel, 1)
			writePrometheusLabeledGauge(w, "wagi_api_jetstream_stream_messages", streamLabel, info.State.Msgs)
			writePrometheusLabeledGauge(w, "wagi_api_jetstream_stream_bytes", streamLabel, info.State.Bytes)
			for _, consumerName := range observabilityConsumers[streamName] {
				consumer, err := a.js.ConsumerInfo(streamName, consumerName)
				if err != nil {
					continue
				}
				labels := fmt.Sprintf(`stream="%s",consumer="%s"`, prometheusLabel(streamName), prometheusLabel(consumer.Name))
				writePrometheusLabeledGauge(w, "wagi_api_jetstream_consumer_pending", labels, consumer.NumPending)
				writePrometheusLabeledGauge(w, "wagi_api_jetstream_consumer_ack_pending", labels, consumer.NumAckPending)
			}
		}
	}

	if len(queryFailures) > 0 {
		writePrometheusHeader(w, "wagi_api_metrics_query_failed", "Metrics queries that failed during this scrape", "gauge")
		for _, source := range queryFailures {
			writePrometheusLabeledGauge(w, "wagi_api_metrics_query_failed", fmt.Sprintf(`source="%s"`, prometheusLabel(source)), 1)
		}
	}
	writePrometheusHeader(w, "wagi_api_scrape_duration_seconds", "Time spent collecting this metrics response", "gauge")
	writePrometheusGauge(w, "wagi_api_scrape_duration_seconds", time.Since(scrapeStarted).Seconds())
}
