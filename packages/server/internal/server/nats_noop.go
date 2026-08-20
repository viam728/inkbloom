package server

import (
	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// NoopNATSPublisher is the local-mode stand-in for NATSManager (task #37,
// M2-a). The embedded mode has no message broker: publishing silently
// succeeds and JetStream() returns nil, which TaskEngine.Start treats as
// "no remote task feed" (workers still run for retries). Outbox publishing
// and the NATS→WebSocket bridge are simply not started in local mode.
type NoopNATSPublisher struct {
	logger *zap.Logger
}

// NewNoopNATSPublisher creates the no-op publisher.
func NewNoopNATSPublisher(logger *zap.Logger) *NoopNATSPublisher {
	return &NoopNATSPublisher{logger: logger}
}

// Publish discards the message (debug-logged) and reports success.
func (p *NoopNATSPublisher) Publish(subject string, data []byte) error {
	p.logger.Debug("noop nats publish dropped", zap.String("subject", subject), zap.Int("bytes", len(data)))
	return nil
}

// JetStream returns nil; callers must treat nil as "broker unavailable".
func (p *NoopNATSPublisher) JetStream() nats.JetStreamContext { return nil }

// Close is a no-op provided for symmetry with NATSManager.
func (p *NoopNATSPublisher) Close() {}
