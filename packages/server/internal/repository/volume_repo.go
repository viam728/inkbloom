package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// VolumeRepository defines the interface for volume data access.
type VolumeRepository interface {
	Create(ctx context.Context, volume *model.Volume) error
	GetByID(ctx context.Context, id int64) (*model.Volume, error)
	ListByNovelID(ctx context.Context, novelID int64) ([]model.Volume, error)
	Update(ctx context.Context, volume *model.Volume) error
	Delete(ctx context.Context, id int64) error
}

// volumeRepository is the GORM implementation of VolumeRepository.
type volumeRepository struct {
	db *gorm.DB
}

// NewVolumeRepository creates a new VolumeRepository backed by GORM.
func NewVolumeRepository(db *gorm.DB) VolumeRepository {
	return &volumeRepository{db: db}
}

func (r *volumeRepository) Create(ctx context.Context, volume *model.Volume) error {
	return r.db.WithContext(ctx).Create(volume).Error
}

func (r *volumeRepository) GetByID(ctx context.Context, id int64) (*model.Volume, error) {
	var volume model.Volume
	if err := r.db.WithContext(ctx).First(&volume, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &volume, nil
}

func (r *volumeRepository) ListByNovelID(ctx context.Context, novelID int64) ([]model.Volume, error) {
	var volumes []model.Volume
	if err := r.db.WithContext(ctx).
		Where("novel_id = ?", novelID).
		Order("position ASC").
		Find(&volumes).Error; err != nil {
		return nil, err
	}
	return volumes, nil
}

func (r *volumeRepository) Update(ctx context.Context, volume *model.Volume) error {
	return r.db.WithContext(ctx).Save(volume).Error
}

func (r *volumeRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&model.Volume{}, id).Error
}
