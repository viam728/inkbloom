package repository

import (
	"context"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// TokenUsageRepository persists the daily consumption aggregate (plan A30, T3).
type TokenUsageRepository interface {
	// UpsertDaily accumulates a day's consumption atomically. textUnits,
	// imageCount and imageUnits are deltas added to the existing row.
	UpsertDaily(ctx context.Context, userID int64, date string, textUnits, imageCount, imageUnits int64) error
	// ListDaily returns the most recent `days` rows for a user, oldest first.
	ListDaily(ctx context.Context, userID int64, days int) ([]model.TokenUsageDaily, error)
}

type tokenUsageRepository struct {
	db *gorm.DB
}

// NewTokenUsageRepository creates a new TokenUsageRepository.
func NewTokenUsageRepository(db *gorm.DB) TokenUsageRepository {
	return &tokenUsageRepository{db: db}
}

func (r *tokenUsageRepository) UpsertDaily(ctx context.Context, userID int64, date string, textUnits, imageCount, imageUnits int64) error {
	row := &model.TokenUsageDaily{
		UserID:     userID,
		Date:       date,
		TextUnits:  textUnits,
		ImageCount: imageCount,
		ImageUnits: imageUnits,
	}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "date"}},
		// 自增列必须用表名限定：DO UPDATE SET 表达式里裸列名在 Postgres
		// 中与 EXCLUDED 伪表歧义（SQLSTATE 42702）。SQLite 同样接受限定名。
		DoUpdates: clause.Assignments(map[string]interface{}{
			"text_units":  gorm.Expr("token_usage_daily.text_units + EXCLUDED.text_units"),
			"image_count": gorm.Expr("token_usage_daily.image_count + EXCLUDED.image_count"),
			"image_units": gorm.Expr("token_usage_daily.image_units + EXCLUDED.image_units"),
			"updated_at":  gorm.Expr("CURRENT_TIMESTAMP"),
		}),
	}).Create(row).Error
}

func (r *tokenUsageRepository) ListDaily(ctx context.Context, userID int64, days int) ([]model.TokenUsageDaily, error) {
	if days <= 0 {
		days = 30
	}
	if days > 365 {
		days = 365
	}
	var list []model.TokenUsageDaily
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("date DESC").
		Limit(days).
		Find(&list).Error
	return list, err
}
