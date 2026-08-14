package main

import (
	"context"
	"log"

	gotdlog "github.com/gotd/log"
)

// connectorGotdLogger bridges gotd's logger to Docker stdout. Attribute
// values are intentionally omitted: gotd can include protocol details in
// structured attributes and QR/session material must never reach container
// logs.
type connectorGotdLogger struct{}

func (connectorGotdLogger) Enabled(_ context.Context, level gotdlog.Level) bool {
	return level >= gotdlog.LevelInfo
}

func (connectorGotdLogger) Log(_ context.Context, level gotdlog.Level, message string, _ ...gotdlog.Attr) {
	if level < gotdlog.LevelInfo {
		return
	}
	log.Printf("gotd level=%s message=%s", level.String(), message)
}

var _ gotdlog.Logger = connectorGotdLogger{}
