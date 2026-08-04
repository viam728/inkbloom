package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// NovelRepository defines the interface for novel data access.
type NovelRepository interface {
	Create(ctx context.Context, novel *model.Novel) error
	GetByID(ctx context.Context, id int64) (*model.Novel, error)
	List(ctx context.Context, offset, limit int) ([]model.Novel, int64, error)
	Update(ctx context.Context, novel *model.Novel) error
	Delete(ctx context.Context, id int64) error
}

// novelRepository is the GORM implementation of NovelRepository.
type novelRepository struct {
	db *gorm.DB
}

// NewNovelRepository creates a new NovelRepository backed by GORM.
func NewNovelRepository(db *gorm.DB) NovelRepository {
	return &novelRepository{db: db}
}

func (r *novelRepository) Create(ctx context.Context, novel *model.Novel) error {
	return r.db.WithContext(ctx).Create(novel).Error
}

func (r *novelRepository) GetByID(ctx context.Context, id int64) (*model.Novel, error) {
	var novel model.Novel
	if err := r.db.WithContext(ctx).First(&novel, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &novel, nil
}

func (r *novelRepository) List(ctx context.Context, offset, limit int) ([]model.Novel, int64, error) {
	var novels []model.Novel
	var total int64

	if err := r.db.WithContext(ctx).Model(&model.Novel{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	if err := r.db.WithContext(ctx).Offset(offset).Limit(limit).Order("id DESC").Find(&novels).Error; err != nil {
		return nil, 0, err
	}

	return novels, total, nil
}

func (r *novelRepository) Update(ctx context.Context, novel *model.Novel) error {
	return r.db.WithContext(ctx).Save(novel).Error
}

func (r *novelRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&model.Novel{}, id).Error
}
