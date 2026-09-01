package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// NovelVersionRepository defines the interface for whole-novel snapshot access
// (Agent safety work Q3). Every method is scoped by userID (contract C3).
type NovelVersionRepository interface {
	Create(ctx context.Context, v *model.NovelVersion) error
	// GetByID returns a snapshot including its bundle, or nil when it does
	// not exist within the user's scope.
	GetByID(ctx context.Context, userID, id int64) (*model.NovelVersion, error)
	// ListByNovel returns snapshot-free summaries ordered newest-first.
	ListByNovel(ctx context.Context, userID, novelID int64, limit, offset int) ([]model.NovelVersion, error)
	// CountByNovel counts every snapshot of one novel. Drives list totals,
	// which cannot be derived from the capped ListByNovel.
	CountByNovel(ctx context.Context, userID, novelID int64) (int64, error)
	// Latest returns the newest snapshot of a novel (bundle excluded).
	Latest(ctx context.Context, userID, novelID int64) (*model.NovelVersion, error)
	// Delete removes a snapshot. Snapshots are the author's own safety net,
	// so deletion is only ever driven by an explicit author action.
	Delete(ctx context.Context, userID, id int64) error
}

type novelVersionRepository struct {
	db *gorm.DB
}

// NewNovelVersionRepository creates a new NovelVersionRepository.
func NewNovelVersionRepository(db *gorm.DB) NovelVersionRepository {
	return &novelVersionRepository{db: db}
}

// novelVersionSummaryColumns excludes the (very large) snapshot payload so
// listing a novel's history never drags whole book bundles over the wire.
const novelVersionSummaryColumns = "id, user_id, novel_id, title, kind, label, content_hash, chapter_count, word_count, created_at"

func (r *novelVersionRepository) Create(ctx context.Context, v *model.NovelVersion) error {
	return r.db.WithContext(ctx).Create(v).Error
}

func (r *novelVersionRepository) GetByID(ctx context.Context, userID, id int64) (*model.NovelVersion, error) {
	var v model.NovelVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		First(&v, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

func (r *novelVersionRepository) ListByNovel(ctx context.Context, userID, novelID int64, limit, offset int) ([]model.NovelVersion, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var versions []model.NovelVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Select(novelVersionSummaryColumns).
		Order("created_at DESC").
		Limit(limit).
		Offset(offset).
		Find(&versions).Error
	if err != nil {
		return nil, err
	}
	return versions, nil
}

func (r *novelVersionRepository) CountByNovel(ctx context.Context, userID, novelID int64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.NovelVersion{}).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Count(&n).Error
	return n, err
}

func (r *novelVersionRepository) Latest(ctx context.Context, userID, novelID int64) (*model.NovelVersion, error) {
	var v model.NovelVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Select(novelVersionSummaryColumns).
		Order("created_at DESC").
		First(&v).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

func (r *novelVersionRepository) Delete(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Delete(&model.NovelVersion{}, id).Error
}
