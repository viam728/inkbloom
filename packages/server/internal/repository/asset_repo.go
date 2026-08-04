package repository

import (
	"context"
	"fmt"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// AssetRepository defines the interface for asset persistence operations.
type AssetRepository interface {
	Create(ctx context.Context, asset *model.Asset) error
	GetByID(ctx context.Context, id int64) (*model.Asset, error)
	ListByNovel(ctx context.Context, novelID int64, limit int) ([]model.Asset, error)
	ListByChapter(ctx context.Context, chapterID int64) ([]model.Asset, error)
	Delete(ctx context.Context, id int64) error
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

func (r *assetRepository) ListByNovel(ctx context.Context, novelID int64, limit int) ([]model.Asset, error) {
	var assets []model.Asset
	query := r.db.WithContext(ctx).
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

func (r *assetRepository) ListByChapter(ctx context.Context, chapterID int64) ([]model.Asset, error) {
	var assets []model.Asset
	if err := r.db.WithContext(ctx).
		Where("chapter_id = ?", chapterID).
		Order("created_at DESC").
		Find(&assets).Error; err != nil {
		return nil, fmt.Errorf("list assets by chapter: %w", err)
	}
	return assets, nil
}

func (r *assetRepository) Delete(ctx context.Context, id int64) error {
	result := r.db.WithContext(ctx).Delete(&model.Asset{}, id)
	if result.Error != nil {
		return fmt.Errorf("delete asset %d: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("asset %d not found", id)
	}
	return nil
}
