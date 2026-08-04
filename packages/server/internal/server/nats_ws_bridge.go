package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// NATSWsBridge subscribes to NATS task events and forwards them to the WebSocket Hub.
type NATSWsBridge struct {
	nats   *NATSManager
	wsHub  *WSHub
	logger *zap.Logger
}

// NewNATSWsBridge creates a new NATSWsBridge.
func NewNATSWsBridge(natsMgr *NATSManager, wsHub *WSHub, logger *zap.Logger) *NATSWsBridge {
	return &NATSWsBridge{
		nats:   natsMgr,
		wsHub:  wsHub,
		logger: logger,
	}
}

// taskEvent represents the structure of NATS task event messages.
type taskEvent struct {
	TaskID   string      `json:"task_id"`
	UserID   string      `json:"user_id"`
	Type     string      `json:"type"`     // created, progress, completed, failed
	Progress int         `json:"progress"` // 0-100
	Status   string      `json:"status"`
	Payload  interface{} `json:"payload"`
}

// Start subscribes to aigc.task.> and forwards events to the WebSocket hub.
func (b *NATSWsBridge) Start(ctx context.Context) error {
	sub, err := b.nats.Conn().Subscribe("aigc.task.>", func(msg *nats.Msg) {
		b.handleNATSMessage(msg)
	})
	if err != nil {
		return fmt.Errorf("nats subscribe aigc.task.>: %w", err)
	}

	b.logger.Info("NATS→WebSocket bridge started, subscribed to aigc.task.>")

	go func() {
		<-ctx.Done()
		_ = sub.Unsubscribe()
		b.logger.Info("NATS→WebSocket bridge stopped")
	}()

	return nil
}

func (b *NATSWsBridge) handleNATSMessage(msg *nats.Msg) {
	// Subject format: aigc.task.{type} e.g. aigc.task.created, aigc.task.progress
	parts := strings.Split(msg.Subject, ".")
	if len(parts) < 3 {
		b.logger.Warn("Invalid NATS subject", zap.String("subject", msg.Subject))
		return
	}
	eventType := parts[2]

	var evt taskEvent
	if err := json.Unmarshal(msg.Data, &evt); err != nil {
		b.logger.Error("Failed to unmarshal NATS message", zap.Error(err),
			zap.String("subject", msg.Subject))
		return
	}

	// Map NATS event type to WS message type
	wsType := "task:" + eventType
	wsMsg := WSMessage{
		Type: wsType,
		Payload: map[string]interface{}{
			"task_id":  evt.TaskID,
			"user_id":  evt.UserID,
			"progress": evt.Progress,
			"status":   evt.Status,
			"data":     evt.Payload,
		},
	}

	// If user_id is present, send to specific user; otherwise broadcast
	if evt.UserID != "" {
		b.wsHub.SendToUser(evt.UserID, wsMsg)
	} else {
		b.wsHub.Broadcast(wsMsg)
	}

	b.logger.Debug("Forwarded NATS event to WebSocket",
		zap.String("type", wsType), zap.String("task_id", evt.TaskID))
}
