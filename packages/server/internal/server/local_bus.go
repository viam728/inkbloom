package server

import (
	"encoding/json"
	"strings"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// LocalBus is the in-process event bus for the embedded desktop mode (tech
// plan v2 §3.2). The local mode has no NATS broker; this publisher satisfies
// task_engine.NATSPublisher and delivers task events straight into the
// WebSocket hub, so the renderer receives task:* progress/completion events
// exactly as it would through the cloud NATS→WS bridge.
//
// Delivery semantics: events carrying a user_id are routed with SendToUser;
// events without one are broadcast (same rule as the cloud bridge).
//
// Task feed: aigc.task.created events additionally hand the task to the
// engine's in-process queue (SetTaskSink) — the local mode has no JetStream
// subscription, so the outbox-published creation event IS the task feed.
type LocalBus struct {
	wsHub    *WSHub
	logger   *zap.Logger
	taskSink func(taskJSON []byte) // optional; wired to TaskEngine.SubmitLocal
}

// NewLocalBus creates the local-mode event bus bound to the WS hub.
func NewLocalBus(wsHub *WSHub, logger *zap.Logger) *LocalBus {
	return &LocalBus{wsHub: wsHub, logger: logger}
}

// SetTaskSink installs the consumer for aigc.task.created events (the
// engine's in-process submission queue). Must be called before the outbox
// publisher starts.
func (b *LocalBus) SetTaskSink(fn func(taskJSON []byte)) {
	b.taskSink = fn
}

// Publish parses the task event and forwards it to the WS hub. Subjects
// follow the cloud convention: aigc.task.{created|progress|completed|failed|...}.
func (b *LocalBus) Publish(subject string, data []byte) error {
	parts := strings.Split(subject, ".")
	if len(parts) < 3 {
		b.logger.Warn("local bus: invalid subject", zap.String("subject", subject))
		return nil
	}
	eventType := parts[2]

	// Task feed: route creation events into the engine queue. The payload IS
	// the marshalled model.Task written by TaskEngine.Submit's outbox row.
	if eventType == "created" && b.taskSink != nil {
		b.taskSink(data)
		return nil // creation events are engine-bound; no WS fan-out needed
	}

	var evt taskEvent
	if err := json.Unmarshal(data, &evt); err != nil {
		b.logger.Error("local bus: failed to unmarshal event", zap.Error(err),
			zap.String("subject", subject))
		return nil // malformed events are dropped, never block the engine
	}

	wsMsg := WSMessage{
		Type: "task:" + eventType,
		Payload: map[string]interface{}{
			"task_id":  evt.TaskID,
			"user_id":  evt.UserID,
			"progress": evt.Progress,
			"status":   evt.Status,
			"data":     evt.Payload,
		},
	}

	if evt.UserID != "" {
		b.wsHub.SendToUser(evt.UserID, wsMsg)
	} else {
		b.wsHub.Broadcast(wsMsg)
	}
	return nil
}

// JetStream returns nil; TaskEngine.Start treats nil as "no remote task
// feed", which is correct for the embedded mode (tasks arrive via Submit).
func (b *LocalBus) JetStream() nats.JetStreamContext { return nil }

// Close is a no-op provided for symmetry with NATSManager.
func (b *LocalBus) Close() {}
