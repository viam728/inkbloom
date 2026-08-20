package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// AssetRepository defines the interface for asset persistence operations.
// Listing/deletion is scoped by user_id (M1 isolation); GetByID remains
// unscoped because it backs the public static file route /assets/files
// (single-machine local files, intentionally public).
type AssetRepository interface {
	Create(ctx context.Context, asset *model.Asset) error
	GetByID(ctx context.Context, id int64) (*model.Asset, error)
	ListByNovel(ctx context.Context, userID, novelID int64, limit int) ([]model.Asset, error)
	ListByChapter(ctx context.Context, userID, chapterID int64) ([]model.Asset, error)
	Delete(ctx context.Context, userID, id int64) error
	// Gallery extensions (task #57).
	GetByUserAndID(ctx context.Context, userID, id int64) (*model.Asset, error)
	FindByUserHash(ctx context.Context, userID int64, hash string) (*model.Asset, error)
	ListByScope(ctx context.Context, userID int64, assetScope string, novelID *int64, limit int, cursorTime *time.Time, cursorID int64) ([]model.Asset, error)
	CountContentReferences(ctx context.Context, userID int64, url string) (int64, error)
	// AIGC history extensions (task #64).
	ListAll(ctx context.Context, userID int64, limit int) ([]model.Asset, error)
	CreateWithRecord(ctx context.Context, asset *model.Asset, rec *model.AIGCRecord) error
}

// assetRepository is the GORM-backed implementation of AssetRepository.
type assetRepository struct {
	db *gorm.DB
}

// NewAssetRepository creates a new AssetRepository.
func NewAssetRepository(db *gorm.DB) AssetRepository {
	return &assetRepository{db: db}
}

func (r *assetRepository) Create(ctx context.Context, asset *model.Asset) error {
	if err := r.db.WithContext(ctx).Create(asset).Error; err != nil {
		return fmt.Errorf("create asset: %w", err)
	}
	return nil
}

func (r *assetRepository) GetByID(ctx context.Context, id int64) (*model.Asset, error) {
	var asset model.Asset
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&asset).Error; err != nil {
		return nil, fmt.Errorf("get asset %d: %w", id, err)
	}
	return &asset, nil
}

func (r *assetRepository) ListByNovel(ctx context.Context, userID, novelID int64, limit int) ([]model.Asset, error) {
	var assets []model.Asset
	query := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Order("created_at DESC")
	if limit > 0 {
		query = query.Limit(limit)
	} else {
		query = query.Limit(50)
	}
	if err := query.Find(&assets).Error; err != nil {
		return nil, fmt.Errorf("list assets by novel: %w", err)
	}
	return assets, nil
}

func (r *assetRepository) ListByChapter(ctx context.Context, userID, chapterID int64) ([]model.Asset, error) {
	var assets []model.Asset
	if err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("chapter_id = ?", chapterID).
		Order("created_at DESC").
		Find(&assets).Error; err != nil {
		return nil, fmt.Errorf("list assets by chapter: %w", err)
	}
	return assets, nil
}

func (r *assetRepository) Delete(ctx context.Context, userID, id int64) error {
	result := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Delete(&model.Asset{}, id)
	if result.Error != nil {
		return fmt.Errorf("delete asset %d: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("asset %d not found", id)
	}
	return nil
}

// GetByUserAndID fetches one asset owned by userID (gallery delete path).
func (r *assetRepository) GetByUserAndID(ctx context.Context, userID, id int64) (*model.Asset, error) {
	var asset model.Asset
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("id = ?", id).
		First(&asset).Error
	if err != nil {
		return nil, fmt.Errorf("get asset %d: %w", id, err)
	}
	return &asset, nil
}

// FindByUserHash looks up an asset by the per-user dedupe key. Returns an
// error wrapping gorm.ErrRecordNotFound when no match exists.
func (r *assetRepository) FindByUserHash(ctx context.Context, userID int64, hash string) (*model.Asset, error) {
	var asset model.Asset
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("content_hash = ?", hash).
		First(&asset).Error
	if err != nil {
		return nil, fmt.Errorf("find asset by hash: %w", err)
	}
	return &asset, nil
}

// ListByScope runs the keyset-paginated gallery listing. assetScope == ""
// lists every scope; cursorTime/cursorID advance the (created_at DESC,
// id DESC) cursor; nil cursorTime fetches the first page.
func (r *assetRepository) ListByScope(ctx context.Context, userID int64, assetScope string, novelID *int64, limit int, cursorTime *time.Time, cursorID int64) ([]model.Asset, error) {
	query := r.db.WithContext(ctx).Scopes(scope.ForUser(userID))
	if assetScope != "" {
		query = query.Where("scope = ?", assetScope)
	}
	if novelID != nil {
		query = query.Where("novel_id = ?", *novelID)
	}
	if cursorTime != nil {
		query = query.Where("created_at < ? OR (created_at = ? AND id < ?)", *cursorTime, *cursorTime, cursorID)
	}
	var assets []model.Asset
	err := query.Order("created_at DESC").Order("id DESC").Limit(limit).Find(&assets).Error
	if err != nil {
		return nil, fmt.Errorf("list assets by scope: %w", err)
	}
	return assets, nil
}

// CountContentReferences coarsely scans the current user's prose columns
// (chapters.content / media_contents.content / media_topics.note) for the
// given asset URL (task #57 delete protection).
func (r *assetRepository) CountContentReferences(ctx context.Context, userID int64, url string) (int64, error) {
	like := "%" + url + "%"
	var total int64

	var chapters int64
	if err := r.db.WithContext(ctx).
		Model(&model.Chapter{}).
		Scopes(scope.ForUser(userID)).
		Where("content LIKE ?", like).
		Count(&chapters).Error; err != nil {
		return 0, fmt.Errorf("scan chapters: %w", err)
	}
	total += chapters

	var contents int64
	if err := r.db.WithContext(ctx).
		Model(&model.MediaContent{}).
		Scopes(scope.ForUser(userID)).
		Where("content LIKE ?", like).
		Count(&contents).Error; err != nil {
		return 0, fmt.Errorf("scan media contents: %w", err)
	}
	total += contents

	var topics int64
	if err := r.db.WithContext(ctx).
		Model(&model.MediaTopic{}).
		Scopes(scope.ForUser(userID)).
		Where("note LIKE ?", like).
		Count(&topics).Error; err != nil {
		return 0, fmt.Errorf("scan media topics: %w", err)
	}
	total += topics

	return total, nil
}

// ListAll lists the user's AIGC assets across all novels (task #64: the
// /api/v1/aigc/assets novel_id filter became optional).
func (r *assetRepository) ListAll(ctx context.Context, userID int64, limit int) ([]model.Asset, error) {
	if limit <= 0 {
		limit = 50
	}
	var assets []model.Asset
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("source = ?", model.AssetSourceAI).
		Order("created_at DESC").
		Limit(limit).
		Find(&assets).Error
	if err != nil {
		return nil, fmt.Errorf("list all aigc assets: %w", err)
	}
	return assets, nil
}

// CreateWithRecord persists the asset and its AIGC history record in one
// transaction (task #64): a record must never exist without its asset and
// vice versa for freshly generated files.
func (r *assetRepository) CreateWithRecord(ctx context.Context, asset *model.Asset, rec *model.AIGCRecord) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(asset).Error; err != nil {
			return fmt.Errorf("create asset: %w", err)
		}
		rec.AssetID = asset.ID
		if err := tx.Create(rec).Error; err != nil {
			return fmt.Errorf("create aigc record: %w", err)
		}
		return nil
	})
}

// IsNotFound reports whether err signals a missing record.
func IsNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}
