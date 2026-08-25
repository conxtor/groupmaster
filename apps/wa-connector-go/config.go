package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Port                  string
	DatabaseURL           string
	NATSURL               string
	BackfillDays          int
	ReconnectCatchupDays  int
	BackfillThrottle      time.Duration
	BackfillGroupDelay    time.Duration
	HistoryPageSize       int
	HistoryRequestDelay   time.Duration
	MediaDownloadAttempts int
	MediaRetryInterval    time.Duration
	MediaDir              string
	MediaCleanupToken     string
	PoolEnabled           bool
	Role                  string
	WorkerID              string
	PreferredAccountID    string
	PoolSize              int
	OnboardingSlots       int
	LeaseSeconds          int
	AccountSlotSeconds    int
	SyncInterval          time.Duration
	PoolRetryDelay        time.Duration
	StartDelay            time.Duration
	GroupRefreshInterval  time.Duration
	SyncGrace             time.Duration
	SQLSchema             string
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value == 0 {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func loadConfig() config {
	role := strings.ToLower(envString("CONNECTOR_ROLE", "processing"))
	if role != "onboarding" {
		role = "processing"
	}
	poolSize := envInt("WA_CONNECTOR_POOL_SIZE", envInt("CONNECTOR_POOL_SIZE", 1))
	onboardingSlots := envInt("WA_ONBOARDING_SLOTS", envInt("CONNECTOR_ONBOARDING_SLOTS", 1))
	return config{
		Port:                  envString("WA_PORT", envString("PORT", "3001")),
		DatabaseURL:           envString("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app?sslmode=disable"),
		NATSURL:               envString("NATS_URL", "nats://localhost:4222"),
		BackfillDays:          maxInt(1, envInt("WA_BACKFILL_DAYS", 7)),
		ReconnectCatchupDays:  maxInt(1, envInt("WA_RECONNECT_CATCHUP_DAYS", 1)),
		BackfillThrottle:      time.Duration(maxInt(0, envInt("WA_BACKFILL_THROTTLE_MS", 250))) * time.Millisecond,
		BackfillGroupDelay:    time.Duration(maxInt(0, envInt("WA_BACKFILL_GROUP_DELAY_MS", 1500))) * time.Millisecond,
		HistoryPageSize:       maxInt(10, envInt("WA_HISTORY_PAGE_SIZE", 50)),
		HistoryRequestDelay:   time.Duration(maxInt(0, envInt("WA_HISTORY_REQUEST_DELAY_MS", 500))) * time.Millisecond,
		MediaDownloadAttempts: maxInt(1, envInt("WA_MEDIA_DOWNLOAD_ATTEMPTS", 3)),
		MediaRetryInterval:    time.Duration(maxInt(0, envInt("WA_MEDIA_RETRY_INTERVAL_MS", 60_000))) * time.Millisecond,
		MediaDir:              envString("MEDIA_DIR", "./data/media"),
		MediaCleanupToken:     envString("MEDIA_CLEANUP_TOKEN", ""),
		PoolEnabled:           envBool("CONNECTOR_POOL_ENABLED", true),
		Role:                  role,
		WorkerID:              envString("CONNECTOR_WORKER_ID", "wa-whatsmeow-"+envString("HOSTNAME", strconv.Itoa(os.Getpid()))),
		PreferredAccountID:    envString("CONNECTOR_ACCOUNT_ID", ""),
		PoolSize:              maxInt(1, poolSize),
		OnboardingSlots:       maxInt(1, onboardingSlots),
		LeaseSeconds:          maxInt(30, envInt("CONNECTOR_LEASE_SECONDS", 90)),
		AccountSlotSeconds:    maxInt(0, envInt("CONNECTOR_ACCOUNT_SLOT_SECONDS", 1800)),
		SyncInterval:          time.Duration(maxInt(30, envInt("CONNECTOR_SYNC_INTERVAL_SECONDS", 300))) * time.Second,
		PoolRetryDelay:        time.Duration(maxInt(5_000, envInt("CONNECTOR_POOL_RETRY_DELAY_MS", 20_000))) * time.Millisecond,
		StartDelay:            time.Duration(maxInt(0, envInt("CONNECTOR_START_DELAY_MS", 0))) * time.Millisecond,
		GroupRefreshInterval:  time.Duration(maxInt(30_000, envInt("GROUP_REFRESH_INTERVAL_MS", 60_000))) * time.Millisecond,
		SyncGrace:             time.Duration(maxInt(0, envInt("WA_SYNC_GRACE_SECONDS", 60))) * time.Second,
		SQLSchema:             envString("WA_WHATSMEOW_SQL_SCHEMA", "wa_whatsmeow"),
	}
}

func maxInt(value, minimum int) int {
	if value < minimum {
		return minimum
	}
	return value
}
