package repository

import (
	"context"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// EventRepository persists analytics events. Append-only: no update or delete
// path is exposed, so the table can be trusted as the raw fact source.
type EventRepository interface {
	CreateBatch(ctx context.Context, events []model.Event) error
	// CountByName counts occurrences of one event since `since`.
	CountByName(ctx context.Context, name string, since time.Time) (int64, error)
}

type eventRepository struct {
	db *gorm.DB
}

// NewEventRepository creates a new EventRepository.
func NewEventRepository(db *gorm.DB) EventRepository {
	return &eventRepository{db: db}
}

func (r *eventRepository) CreateBatch(ctx context.Context, events []model.Event) error {
	if len(events) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Create(&events).Error
}

func (r *eventRepository) CountByName(ctx context.Context, name string, since time.Time) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.Event{}).
		Where("event = ? AND created_at >= ?", name, since).
		Count(&n).Error
	return n, err
}
