package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	Port                 string
	DatabaseURL          string
	NATSURL              string
	APIID                int
	APIHash              string
	BackfillDays         int
	BackfillThrottle     time.Duration
	BackfillGroupDelay   time.Duration
	MediaDir             string
	MediaCleanupToken    string
	StateDir             string
	PoolEnabled          bool
	Role                 string
	WorkerID             string
	PreferredAccountID   string
	PoolSize             int
	OnboardingSlots      int
	LeaseSeconds         int
	AccountSlotSeconds   int
	SyncInterval         time.Duration
	PoolRetryDelay       time.Duration
	StartDelay           time.Duration
	GroupRefreshInterval time.Duration
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
	poolSize := envInt("TG_CONNECTOR_POOL_SIZE", envInt("CONNECTOR_POOL_SIZE", 1))
	onboardingSlots := envInt("TG_ONBOARDING_SLOTS", envInt("CONNECTOR_ONBOARDING_SLOTS", 1))
	leaseSeconds := envInt("CONNECTOR_LEASE_SECONDS", 90)
	return config{
		Port:                 envString("TG_PORT", envString("PORT", "3002")),
		DatabaseURL:          envString("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app"),
		NATSURL:              envString("NATS_URL", "nats://localhost:4222"),
		APIID:                envInt("TG_API_ID", 0),
		APIHash:              envString("TG_API_HASH", ""),
		BackfillDays:         maxInt(1, envInt("TG_BACKFILL_DAYS", 7)),
		BackfillThrottle:     time.Duration(maxInt(0, envInt("TG_BACKFILL_THROTTLE_MS", 500))) * time.Millisecond,
		BackfillGroupDelay:   time.Duration(maxInt(0, envInt("TG_BACKFILL_GROUP_DELAY_MS", 2000))) * time.Millisecond,
		MediaDir:             envString("MEDIA_DIR", "./data/media"),
		MediaCleanupToken:    envString("MEDIA_CLEANUP_TOKEN", ""),
		StateDir:             envString("TG_STATE_DIR", "./data/tg-state"),
		PoolEnabled:          envBool("CONNECTOR_POOL_ENABLED", true),
		Role:                 role,
		WorkerID:             envString("CONNECTOR_WORKER_ID", "tg-"+envString("HOSTNAME", strconv.Itoa(os.Getpid()))),
		PreferredAccountID:   envString("CONNECTOR_ACCOUNT_ID", ""),
		PoolSize:             maxInt(1, poolSize),
		OnboardingSlots:      maxInt(1, onboardingSlots),
		LeaseSeconds:         maxInt(30, leaseSeconds),
		AccountSlotSeconds:   maxInt(0, envInt("CONNECTOR_ACCOUNT_SLOT_SECONDS", 1800)),
		SyncInterval:         time.Duration(maxInt(30, envInt("CONNECTOR_SYNC_INTERVAL_SECONDS", 300))) * time.Second,
		PoolRetryDelay:       time.Duration(maxInt(5_000, envInt("CONNECTOR_POOL_RETRY_DELAY_MS", 20_000))) * time.Millisecond,
		StartDelay:           time.Duration(maxInt(0, envInt("CONNECTOR_START_DELAY_MS", 0))) * time.Millisecond,
		GroupRefreshInterval: time.Duration(maxInt(30_000, envInt("GROUP_REFRESH_INTERVAL_MS", 60_000))) * time.Millisecond,
	}
}

func maxInt(value, minimum int) int {
	if value < minimum {
		return minimum
	}
	return value
}
