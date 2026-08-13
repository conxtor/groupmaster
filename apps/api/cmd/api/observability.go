package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

type observabilityLabelCount struct {
	Label string `json:"label"`
	Count int64  `json:"count"`
}

type observabilitySummary struct {
	Users            int64                     `json:"users"`
	ActiveUsers      int64                     `json:"activeUsers"`
	DisabledUsers    int64                     `json:"disabledUsers"`
	AdminUsers       int64                     `json:"adminUsers"`
	Groups           int64                     `json:"groups"`
	SelectedGroups   int64                     `json:"selectedGroups"`
	Messages         int64                     `json:"messages"`
	RecentMessages   int64                     `json:"recentMessages"`
	Relevant         int64                     `json:"relevantMessages"`
	Failures         int64                     `json:"processingFailures"`
	LastMessageAt    *time.Time                `json:"lastMessageAt,omitempty"`
	GroupsByPlatform []observabilityLabelCount `json:"groupsByPlatform"`
	MessagesByKind   []observabilityLabelCount `json:"messagesByKind"`
}

type processingLoopView struct {
	Name              string `json:"name"`
	Total             int64  `json:"total"`
	Queued            int64  `json:"queued"`
	Processing        int64  `json:"processing"`
	Completed         int64  `json:"completed"`
	Failed            int64  `json:"failed"`
	Retry             int64  `json:"retry"`
	OldestWaitSeconds int64  `json:"oldestWaitSeconds"`
}

type observabilityQueueView struct {
	Platform          string `json:"platform"`
	Kind              string `json:"kind"`
	Waiting           int64  `json:"waiting"`
	OldestWaitSeconds int64  `json:"oldestWaitSeconds"`
	Capacity          int    `json:"capacity"`
	Active            int    `json:"active"`
}

type connectorPoolView struct {
	Platform              string `json:"platform"`
	ProcessingCapacity    int    `json:"processingCapacity"`
	OnboardingCapacity    int    `json:"onboardingCapacity"`
	ActiveProcessing      int    `json:"activeProcessing"`
	ActiveOnboarding      int    `json:"activeOnboarding"`
	AvailableProcessing   int    `json:"availableProcessing"`
	AvailableOnboarding   int    `json:"availableOnboarding"`
	ProcessingWaiting     int64  `json:"processingWaiting"`
	ProcessingWaitSeconds int64  `json:"processingWaitSeconds"`
	OnboardingWaiting     int64  `json:"onboardingWaiting"`
	OnboardingWaitSeconds int64  `json:"onboardingWaitSeconds"`
}

type connectorLeaseView struct {
	AccountID        string    `json:"accountId"`
	Platform         string    `json:"platform"`
	LeaseKind        string    `json:"leaseKind"`
	WorkerID         string    `json:"workerId"`
	LeaseUntil       time.Time `json:"leaseUntil"`
	RemainingSeconds int64     `json:"remainingSeconds"`
	UserID           string    `json:"userId"`
	UserName         string    `json:"userName"`
	UserEmail        string    `json:"userEmail"`
	AccountStatus    string    `json:"accountStatus"`
}

type connectorLeaseHistoryView struct {
	ID              string     `json:"id"`
	AccountID       string     `json:"accountId"`
	Platform        string     `json:"platform"`
	LeaseKind       string     `json:"leaseKind"`
	WorkerID        string     `json:"workerId"`
	UserID          string     `json:"userId"`
	UserName        string     `json:"userName"`
	UserEmail       string     `json:"userEmail"`
	AccountStatus   string     `json:"accountStatus"`
	StartedAt       time.Time  `json:"startedAt"`
	LeaseUntil      time.Time  `json:"leaseUntil"`
	EndedAt         *time.Time `json:"endedAt,omitempty"`
	DurationSeconds int64      `json:"durationSeconds"`
	State           string     `json:"state"`
	EndReason       *string    `json:"endReason,omitempty"`
}

type aiProcessingHistoryView struct {
	ID              string    `json:"id"`
	MessageID       string    `json:"messageId"`
	MediaType       string    `json:"mediaType"`
	Status          string    `json:"status"`
	Attempts        int       `json:"attempts"`
	Model           string    `json:"model,omitempty"`
	GroupSubject    string    `json:"groupSubject,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
	DurationSeconds int64     `json:"durationSeconds"`
	Error           string    `json:"error,omitempty"`
}

type jetStreamConsumerView struct {
	Name          string `json:"name"`
	FilterSubject string `json:"filterSubject"`
	Pending       int    `json:"pending"`
	AckPending    int    `json:"ackPending"`
	Redelivered   int    `json:"redelivered"`
	Waiting       int    `json:"waiting"`
	MaxDeliver    int    `json:"maxDeliver"`
}

type jetStreamView struct {
	Name          string                  `json:"name"`
	Status        string                  `json:"status"`
	Subjects      []string                `json:"subjects"`
	Storage       string                  `json:"storage"`
	Messages      uint64                  `json:"messages"`
	Bytes         uint64                  `json:"bytes"`
	FirstSequence uint64                  `json:"firstSequence"`
	LastSequence  uint64                  `json:"lastSequence"`
	Consumers     []jetStreamConsumerView `json:"consumers"`
	Error         string                  `json:"error,omitempty"`
}

type natsObservabilityView struct {
	Connected   bool     `json:"connected"`
	Servers     []string `json:"servers"`
	InMessages  uint64   `json:"inMessages"`
	OutMessages uint64   `json:"outMessages"`
	InBytes     uint64   `json:"inBytes"`
	OutBytes    uint64   `json:"outBytes"`
	Reconnects  uint64   `json:"reconnects"`
}

type minioObservabilityView struct {
	Endpoint     string                         `json:"endpoint"`
	Bucket       string                         `json:"bucket"`
	Connected    bool                           `json:"connected"`
	BucketExists bool                           `json:"bucketExists"`
	ObjectCount  int64                          `json:"objectCount"`
	TotalBytes   int64                          `json:"totalBytes"`
	LastModified *time.Time                     `json:"lastModified,omitempty"`
	Buckets      []minioBucketObservabilityView `json:"buckets"`
	Error        string                         `json:"error,omitempty"`
}

type adminObservabilityView struct {
	GeneratedAt         time.Time                   `json:"generatedAt"`
	Summary             observabilitySummary        `json:"summary"`
	ProcessingLoops     []processingLoopView        `json:"processingLoops"`
	Queues              []observabilityQueueView    `json:"queues"`
	ConnectorPools      []connectorPoolView         `json:"connectorPools"`
	ActiveLeases        []connectorLeaseView        `json:"activeLeases"`
	RecentLeases        []connectorLeaseHistoryView `json:"recentLeases"`
	AIProcessingHistory []aiProcessingHistoryView   `json:"aiProcessingHistory"`
	NATS                natsObservabilityView       `json:"nats"`
	MinIO               minioObservabilityView      `json:"minio"`
	Streams             []jetStreamView             `json:"streams"`
}

var observabilityConsumers = map[string][]string{
	"WAGI_EVENTS": {
		"WAGI_AI_MESSAGES", "WAGI_AI_TRANSCRIPTS", "WAGI_AI_IMAGES", "WAGI_AI_DOCUMENTS",
		"WAGI_AI_REPLAY", "WAGI_MEDIA_OBJECTS", "WAGI_MEDIA_AUDIO",
	},
	"WAGI_DLQ": {},
}

func (a *app) adminObservability(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	view, err := a.collectObservability(r)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "observability unavailable", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) collectObservability(r *http.Request) (adminObservabilityView, error) {
	ctx := r.Context()
	view := adminObservabilityView{
		GeneratedAt:         time.Now().UTC(),
		ProcessingLoops:     make([]processingLoopView, 0),
		Queues:              make([]observabilityQueueView, 0),
		ConnectorPools:      make([]connectorPoolView, 0, 2),
		ActiveLeases:        make([]connectorLeaseView, 0),
		RecentLeases:        make([]connectorLeaseHistoryView, 0, 10),
		AIProcessingHistory: make([]aiProcessingHistoryView, 0, 20),
		Streams:             make([]jetStreamView, 0, len(observabilityConsumers)),
	}
	view.Summary.GroupsByPlatform = make([]observabilityLabelCount, 0)
	view.Summary.MessagesByKind = make([]observabilityLabelCount, 0)

	if err := a.db.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM app_users),
			(SELECT COUNT(*) FROM app_users WHERE status='active'),
			(SELECT COUNT(*) FROM app_users WHERE status='disabled'),
			(SELECT COUNT(*) FROM app_users u JOIN user_roles ur ON ur.user_id=u.id AND ur.role_name='admin' WHERE u.status='active'),
			(SELECT COUNT(*) FROM wa_groups),
			(SELECT COUNT(*) FROM wa_groups WHERE is_selected=TRUE),
			(SELECT COUNT(*) FROM messages),
			(SELECT COUNT(*) FROM messages WHERE received_at >= NOW() - INTERVAL '24 hours'),
			(SELECT COUNT(*) FROM message_analyses WHERE relevant=TRUE),
			(SELECT COUNT(*) FROM event_failures),
			(SELECT MAX(received_at) FROM messages)
		`).Scan(
		&view.Summary.Users, &view.Summary.ActiveUsers, &view.Summary.DisabledUsers, &view.Summary.AdminUsers,
		&view.Summary.Groups, &view.Summary.SelectedGroups, &view.Summary.Messages, &view.Summary.RecentMessages,
		&view.Summary.Relevant, &view.Summary.Failures, &view.Summary.LastMessageAt,
	); err != nil {
		return view, err
	}

	if err := scanLabelCounts(ctx, a, `SELECT platform, COUNT(*) FROM wa_groups GROUP BY platform ORDER BY platform`, &view.Summary.GroupsByPlatform); err != nil {
		return view, err
	}
	if err := scanLabelCounts(ctx, a, `SELECT kind, COUNT(*) FROM messages GROUP BY kind ORDER BY kind`, &view.Summary.MessagesByKind); err != nil {
		return view, err
	}

	loopQueries := []struct {
		name  string
		query string
	}{
		{"audio", `SELECT COUNT(*), COUNT(*) FILTER (WHERE status='queued'), COUNT(*) FILTER (WHERE status='processing'), COUNT(*) FILTER (WHERE status='completed'), COUNT(*) FILTER (WHERE status='failed'), 0::bigint, COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(CASE WHEN status='queued' THEN COALESCE(next_attempt_at,updated_at) END)))::bigint,0) FROM audio_jobs`},
		{"ai", `SELECT COUNT(*), COUNT(*) FILTER (WHERE status='queued'), COUNT(*) FILTER (WHERE status='processing'), COUNT(*) FILTER (WHERE status='completed'), COUNT(*) FILTER (WHERE status='failed'), 0::bigint, COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(CASE WHEN status='queued' THEN COALESCE(next_attempt_at,updated_at) END)))::bigint,0) FROM ai_jobs`},
		{"media", `SELECT COUNT(*), COUNT(*) FILTER (WHERE status='pending'), COUNT(*) FILTER (WHERE status='processing'), COUNT(*) FILTER (WHERE status='completed'), COUNT(*) FILTER (WHERE status='failed'), 0::bigint, COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(CASE WHEN status IN ('pending','processing') THEN updated_at END)))::bigint,0) FROM media_objects`},
		{"event-inbox", `SELECT COUNT(*), COUNT(*) FILTER (WHERE status IN ('retry','processing')), COUNT(*) FILTER (WHERE status='processing'), COUNT(*) FILTER (WHERE status='processed'), COUNT(*) FILTER (WHERE status='failed'), COUNT(*) FILTER (WHERE status='retry'), COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(CASE WHEN status IN ('retry','processing') THEN updated_at END)))::bigint,0) FROM event_inbox`},
		{"replay", `SELECT COUNT(*), COUNT(*) FILTER (WHERE status='requested'), COUNT(*) FILTER (WHERE status='running'), COUNT(*) FILTER (WHERE status='completed'), COUNT(*) FILTER (WHERE status='failed'), 0::bigint, COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(CASE WHEN status IN ('requested','running') THEN created_at END)))::bigint,0) FROM replay_jobs`},
	}
	for _, item := range loopQueries {
		loop := processingLoopView{Name: item.name}
		if err := a.db.QueryRow(ctx, item.query).Scan(&loop.Total, &loop.Queued, &loop.Processing, &loop.Completed, &loop.Failed, &loop.Retry, &loop.OldestWaitSeconds); err != nil {
			return view, err
		}
		view.ProcessingLoops = append(view.ProcessingLoops, loop)
	}

	type poolStats struct {
		activeProcessing, activeOnboarding       int
		processingWaiting, processingWaitSeconds int64
		onboardingWaiting, onboardingWaitSeconds int64
	}
	stats := map[string]*poolStats{"whatsapp": &poolStats{}, "telegram": &poolStats{}}
	rows, err := a.db.Query(ctx, `SELECT ca.platform, cl.lease_kind, COUNT(*) FROM connector_leases cl JOIN connector_accounts ca ON ca.id=cl.account_id WHERE cl.lease_until>NOW() GROUP BY ca.platform, cl.lease_kind`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var platform, kind string
		var count int64
		if err := rows.Scan(&platform, &kind, &count); err != nil {
			rows.Close()
			return view, err
		}
		if item := stats[platform]; item != nil {
			if kind == "processing" {
				item.activeProcessing = int(count)
			} else if kind == "onboarding" {
				item.activeOnboarding = int(count)
			}
		}
	}
	rows.Close()
	rows, err = a.db.Query(ctx, `
		SELECT platform, COUNT(*)::bigint,
		       COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(next_sync_at)))::bigint,0)
		FROM connector_accounts ca
		WHERE session_data IS NOT NULL AND status IN ('disconnected','paused','degraded') AND next_sync_at<=NOW()
		  AND NOT EXISTS (SELECT 1 FROM connector_leases cl WHERE cl.account_id=ca.id AND cl.lease_kind='processing' AND cl.lease_until>NOW())
		  AND NOT EXISTS (SELECT 1 FROM connector_onboarding_requests cor WHERE cor.account_id=ca.id AND cor.status IN ('pending','claimed','connected'))
		GROUP BY platform`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var platform string
		var waiting, waitSeconds int64
		if err := rows.Scan(&platform, &waiting, &waitSeconds); err != nil {
			rows.Close()
			return view, err
		}
		if item := stats[platform]; item != nil {
			item.processingWaiting, item.processingWaitSeconds = waiting, waitSeconds
		}
	}
	rows.Close()
	rows, err = a.db.Query(ctx, `SELECT platform, COUNT(*)::bigint, COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at)))::bigint,0) FROM connector_onboarding_requests WHERE status='pending' GROUP BY platform`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var platform string
		var waiting, waitSeconds int64
		if err := rows.Scan(&platform, &waiting, &waitSeconds); err != nil {
			rows.Close()
			return view, err
		}
		if item := stats[platform]; item != nil {
			item.onboardingWaiting, item.onboardingWaitSeconds = waiting, waitSeconds
		}
	}
	rows.Close()
	for _, platform := range []string{"whatsapp", "telegram"} {
		item := stats[platform]
		processingCapacity, onboardingCapacity := a.waPoolSize, a.waOnboardingSlots
		if platform == "telegram" {
			processingCapacity, onboardingCapacity = a.tgPoolSize, a.tgOnboardingSlots
		}
		view.ConnectorPools = append(view.ConnectorPools, connectorPoolView{
			Platform: platform, ProcessingCapacity: processingCapacity, OnboardingCapacity: onboardingCapacity,
			ActiveProcessing: item.activeProcessing, ActiveOnboarding: item.activeOnboarding,
			AvailableProcessing: maxInt(0, processingCapacity-item.activeProcessing), AvailableOnboarding: maxInt(0, onboardingCapacity-item.activeOnboarding),
			ProcessingWaiting: item.processingWaiting, ProcessingWaitSeconds: item.processingWaitSeconds,
			OnboardingWaiting: item.onboardingWaiting, OnboardingWaitSeconds: item.onboardingWaitSeconds,
		})
		view.Queues = append(view.Queues,
			observabilityQueueView{Platform: platform, Kind: "processing", Waiting: item.processingWaiting, OldestWaitSeconds: item.processingWaitSeconds, Capacity: processingCapacity, Active: item.activeProcessing},
			observabilityQueueView{Platform: platform, Kind: "onboarding", Waiting: item.onboardingWaiting, OldestWaitSeconds: item.onboardingWaitSeconds, Capacity: onboardingCapacity, Active: item.activeOnboarding},
		)
	}

	rows, err = a.db.Query(ctx, `
		SELECT ca.id::text, ca.platform, cl.lease_kind, cl.worker_id, cl.lease_until,
		       GREATEST(0, EXTRACT(EPOCH FROM (cl.lease_until-NOW()))::bigint), u.id::text, u.name, u.email, ca.status
		FROM connector_leases cl JOIN connector_accounts ca ON ca.id=cl.account_id JOIN app_users u ON u.id=ca.user_id
		WHERE cl.lease_until>NOW() ORDER BY ca.platform, cl.lease_kind, u.email`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var item connectorLeaseView
		if err := rows.Scan(&item.AccountID, &item.Platform, &item.LeaseKind, &item.WorkerID, &item.LeaseUntil, &item.RemainingSeconds, &item.UserID, &item.UserName, &item.UserEmail, &item.AccountStatus); err != nil {
			rows.Close()
			return view, err
		}
		view.ActiveLeases = append(view.ActiveLeases, item)
	}
	rows.Close()

	rows, err = a.db.Query(ctx, `
		SELECT h.id::text, h.account_id::text, h.platform, h.lease_kind, h.worker_id,
		       u.id::text, u.name, u.email, ca.status, h.started_at, h.lease_until, h.ended_at,
		       CASE
		         WHEN h.ended_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (h.ended_at-h.started_at))::bigint)
		         WHEN h.lease_until>NOW() THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW()-h.started_at))::bigint)
		         ELSE GREATEST(0, EXTRACT(EPOCH FROM (h.lease_until-h.started_at))::bigint)
		       END,
		       CASE WHEN h.ended_at IS NOT NULL THEN 'completed' WHEN h.lease_until>NOW() THEN 'active' ELSE 'expired' END,
		       h.end_reason
		FROM connector_lease_history h
		JOIN connector_accounts ca ON ca.id=h.account_id
		JOIN app_users u ON u.id=h.user_id
		ORDER BY h.started_at DESC
		LIMIT 10`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var item connectorLeaseHistoryView
		if err := rows.Scan(&item.ID, &item.AccountID, &item.Platform, &item.LeaseKind, &item.WorkerID, &item.UserID, &item.UserName, &item.UserEmail, &item.AccountStatus, &item.StartedAt, &item.LeaseUntil, &item.EndedAt, &item.DurationSeconds, &item.State, &item.EndReason); err != nil {
			rows.Close()
			return view, err
		}
		view.RecentLeases = append(view.RecentLeases, item)
	}
	rows.Close()

	rows, err = a.db.Query(ctx, `
		SELECT aj.id::text, aj.message_id::text, COALESCE(m.kind,'unknown'), aj.status, aj.attempts,
		       COALESCE(a.model,''), COALESCE(g.subject,''), aj.created_at, aj.updated_at,
		       GREATEST(0, EXTRACT(EPOCH FROM ((CASE WHEN aj.status IN ('completed','failed') THEN aj.updated_at ELSE NOW() END)-aj.created_at))::bigint),
		       COALESCE(aj.error,'')
		FROM ai_jobs aj
		JOIN messages m ON m.id=aj.message_id
		LEFT JOIN message_analyses a ON a.message_id=aj.message_id
		LEFT JOIN wa_groups g ON g.id=m.group_id
		ORDER BY aj.updated_at DESC, aj.created_at DESC
		LIMIT 20`)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var item aiProcessingHistoryView
		if err := rows.Scan(&item.ID, &item.MessageID, &item.MediaType, &item.Status, &item.Attempts, &item.Model, &item.GroupSubject, &item.CreatedAt, &item.UpdatedAt, &item.DurationSeconds, &item.Error); err != nil {
			rows.Close()
			return view, err
		}
		view.AIProcessingHistory = append(view.AIProcessingHistory, item)
	}
	rows.Close()

	if a.nc != nil {
		stats := a.nc.Stats()
		view.NATS = natsObservabilityView{Connected: a.nc.IsConnected(), Servers: append([]string(nil), a.nc.Servers()...), InMessages: stats.InMsgs, OutMessages: stats.OutMsgs, InBytes: stats.InBytes, OutBytes: stats.OutBytes, Reconnects: stats.Reconnects}
	}
	view.MinIO = a.collectMinIOObservability(ctx)
	for streamName, consumerNames := range observabilityConsumers {
		stream := jetStreamView{Name: streamName, Status: "unavailable", Subjects: make([]string, 0), Consumers: make([]jetStreamConsumerView, 0)}
		info, err := a.js.StreamInfo(streamName)
		if err != nil {
			stream.Error = err.Error()
			view.Streams = append(view.Streams, stream)
			continue
		}
		stream.Status = "ready"
		stream.Subjects = append(stream.Subjects, info.Config.Subjects...)
		stream.Storage = fmt.Sprint(info.Config.Storage)
		stream.Messages, stream.Bytes, stream.FirstSequence, stream.LastSequence = info.State.Msgs, info.State.Bytes, info.State.FirstSeq, info.State.LastSeq
		for _, consumerName := range consumerNames {
			consumer, consumerErr := a.js.ConsumerInfo(streamName, consumerName)
			if consumerErr != nil {
				continue
			}
			stream.Consumers = append(stream.Consumers, jetStreamConsumerView{Name: consumer.Name, FilterSubject: consumer.Config.FilterSubject, Pending: int(consumer.NumPending), AckPending: consumer.NumAckPending, Redelivered: consumer.NumRedelivered, Waiting: consumer.NumWaiting, MaxDeliver: consumer.Config.MaxDeliver})
		}
		sort.Slice(stream.Consumers, func(i, j int) bool { return strings.Compare(stream.Consumers[i].Name, stream.Consumers[j].Name) < 0 })
		view.Streams = append(view.Streams, stream)
	}
	sort.Slice(view.Streams, func(i, j int) bool { return strings.Compare(view.Streams[i].Name, view.Streams[j].Name) < 0 })
	return view, nil
}

func scanLabelCounts(ctx context.Context, a *app, query string, target *[]observabilityLabelCount) error {
	rows, err := a.db.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var item observabilityLabelCount
		if err := rows.Scan(&item.Label, &item.Count); err != nil {
			return err
		}
		*target = append(*target, item)
	}
	return rows.Err()
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
