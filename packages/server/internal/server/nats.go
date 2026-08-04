package server

import (
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// NATSManager manages the NATS connection and JetStream context.
type NATSManager struct {
	conn   *nats.Conn
	js     nats.JetStreamContext
	logger *zap.Logger
}

// NewNATSManager creates a new NATSManager and connects to the NATS server.
func NewNATSManager(url string, logger *zap.Logger) (*NATSManager, error) {
	conn, err := nats.Connect(url,
		nats.MaxReconnects(-1), // unlimited reconnects
		nats.ReconnectWait(2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				logger.Warn("NATS disconnected", zap.Error(err))
			}
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			logger.Info("NATS reconnected")
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}

	js, err := conn.JetStream()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("nats jetstream: %w", err)
	}

	logger.Info("NATS connection established", zap.String("url", url))

	return &NATSManager{
		conn:   conn,
		js:     js,
		logger: logger,
	}, nil
}

// JetStream returns the JetStream context.
func (m *NATSManager) JetStream() nats.JetStreamContext {
	return m.js
}

// Conn returns the underlying NATS connection.
func (m *NATSManager) Conn() *nats.Conn {
	return m.conn
}

// CreateStreams creates the required JetStream streams.
func (m *NATSManager) CreateStreams() error {
	_, err := m.js.AddStream(&nats.StreamConfig{
		Name:      "AIGC_TASKS",
		Subjects:  []string{"aigc.task.>"},
		Retention: nats.WorkQueuePolicy,
		MaxAge:    72 * time.Hour,
		MaxMsgs:   10000,
		Storage:   nats.FileStorage,
	})
	if err != nil {
		return fmt.Errorf("create AIGC_TASKS stream: %w", err)
	}

	m.logger.Info("JetStream stream AIGC_TASKS created/updated")
	return nil
}

// Publish publishes a message to the given subject.
func (m *NATSManager) Publish(subject string, data []byte) error {
	_, err := m.js.Publish(subject, data)
	if err != nil {
		return fmt.Errorf("nats publish %s: %w", subject, err)
	}
	return nil
}

// Close gracefully closes the NATS connection.
func (m *NATSManager) Close() error {
	if m.conn != nil {
		m.conn.Drain()
		m.conn.Close()
		m.logger.Info("NATS connection closed")
	}
	return nil
}
