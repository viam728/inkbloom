package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// AIGCRecordRepository persists AIGC generation history (task #64).
// Listing is keyset-paginated over (created_at DESC, id DESC), matching
// the /api/v1/images cursor style.
type AIGCRecordRepository interface {
	Create(ctx context.Context, rec *model.AIGCRecord) error
	ListByUser(ctx context.Context, userID int64, novelID *int64, recordScope string, limit int, cursorTime *time.Time, cursorID int64) ([]model.AIGCRecord, error)
}

type aigcRecordRepository struct {
	db *gorm.DB
}

// NewAIGCRecordRepository creates a new AIGCRecordRepository.
func NewAIGCRecordRepository(db *gorm.DB) AIGCRecordRepository {
	return &aigcRecordRepository{db: db}
}

func (r *aigcRecordRepository) Create(ctx context.Context, rec *model.AIGCRecord) error {
	if err := r.db.WithContext(ctx).Create(rec).Error; err != nil {
		return fmt.Errorf("create aigc record: %w", err)
	}
	return nil
}

// ListByUser runs the keyset-paginated AIGC history listing. novelID and
// recordScope are optional filters; cursorTime == nil fetches the first
// page.
func (r *aigcRecordRepository) ListByUser(ctx context.Context, userID int64, novelID *int64, recordScope string, limit int, cursorTime *time.Time, cursorID int64) ([]model.AIGCRecord, error) {
	query := r.db.WithContext(ctx).Scopes(scope.ForUser(userID))
	if novelID != nil {
		query = query.Where("novel_id = ?", *novelID)
	}
	if recordScope != "" {
		query = query.Where("scope = ?", recordScope)
	}
	if cursorTime != nil {
		query = query.Where("created_at < ? OR (created_at = ? AND id < ?)", *cursorTime, *cursorTime, cursorID)
	}
	if limit <= 0 {
		limit = 20
	}
	var records []model.AIGCRecord
	err := query.Order("created_at DESC").Order("id DESC").Limit(limit).Find(&records).Error
	if err != nil {
		return nil, fmt.Errorf("list aigc records: %w", err)
	}
	return records, nil
}
