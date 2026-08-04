package task_engine

import (
	"context"
	"time"

	"github.com/inkbloom/server/internal/model"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// OutboxPublisher polls the outbox table and publishes pending events to NATS.
type OutboxPublisher struct {
	db     *gorm.DB
	nats   NATSPublisher
	logger *zap.Logger
}

// NewOutboxPublisher creates a new OutboxPublisher.
func NewOutboxPublisher(db *gorm.DB, nats NATSPublisher, logger *zap.Logger) *OutboxPublisher {
	return &OutboxPublisher{
		db:     db,
		nats:   nats,
		logger: logger,
	}
}

// Start begins polling the outbox table and publishing events.
// It blocks until ctx is cancelled.
func (p *OutboxPublisher) Start(ctx context.Context) error {
	p.logger.Info("outbox publisher started")

	interval := 500 * time.Millisecond
	maxIdleInterval := 2 * time.Second

	for {
		select {
		case <-ctx.Done():
			p.logger.Info("outbox publisher stopped")
			return ctx.Err()
		default:
		}

		processed := p.pollAndPublish(ctx)

		if processed == 0 {
			// No events to process → back off
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(maxIdleInterval):
			}
		} else {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(interval):
			}
		}
	}
}

// pollAndPublish fetches pending outbox records and publishes them to NATS.
// Returns the number of records processed.
func (p *OutboxPublisher) pollAndPublish(ctx context.Context) int {
	var records []model.Outbox
	if err := p.db.WithContext(ctx).
		Where("status = ?", "pending").
		Order("id ASC").
		Limit(50).
		Find(&records).Error; err != nil {
		p.logger.Error("failed to poll outbox", zap.Error(err))
		return 0
	}

	if len(records) == 0 {
		return 0
	}

	published := 0
	for _, record := range records {
		if err := p.publishRecord(ctx, &record); err != nil {
			p.logger.Error("failed to publish outbox record",
				zap.Int64("outbox_id", record.ID),
				zap.Error(err),
			)
			// Mark as failed for later retry
			p.db.WithContext(ctx).Model(&model.Outbox{}).
				Where("id = ?", record.ID).
				Update("status", "failed")
			continue
		}
		published++
	}

	return published
}

// publishRecord publishes a single outbox record to NATS and marks it as published.
func (p *OutboxPublisher) publishRecord(ctx context.Context, record *model.Outbox) error {
	if err := p.nats.Publish(record.EventType, []byte(record.Payload)); err != nil {
		return err
	}

	now := time.Now()
	if err := p.db.WithContext(ctx).Model(&model.Outbox{}).
		Where("id = ?", record.ID).
		Updates(map[string]interface{}{
			"status":       "published",
			"published_at": now,
		}).Error; err != nil {
		return err
	}

	return nil
}
