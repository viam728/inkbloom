package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// NovelRepository defines the interface for novel data access. Every method
// is scoped by userID (M1 isolation): queries never see another user's rows
// and ownership-violating lookups degrade to "not found".
type NovelRepository interface {
	Create(ctx context.Context, novel *model.Novel) error
	GetByID(ctx context.Context, userID, id int64) (*model.Novel, error)
	List(ctx context.Context, userID int64, offset, limit int) ([]model.Novel, int64, error)
	// ListAll returns every novel across users. Server-startup data migrations
	// only (e.g. binding orphan chapters into outlines); never expose via API.
	ListAll(ctx context.Context) ([]model.Novel, error)
	Update(ctx context.Context, userID int64, novel *model.Novel) error
	Delete(ctx context.Context, userID, id int64) error
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

func (r *novelRepository) GetByID(ctx context.Context, userID, id int64) (*model.Novel, error) {
	var novel model.Novel
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		First(&novel, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &novel, nil
}

func (r *novelRepository) List(ctx context.Context, userID int64, offset, limit int) ([]model.Novel, int64, error) {
	var novels []model.Novel
	var total int64

	scoped := func() *gorm.DB {
		return r.db.WithContext(ctx).Model(&model.Novel{}).Scopes(scope.ForUser(userID))
	}
	if err := scoped().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	if err := scoped().Offset(offset).Limit(limit).Order("id DESC").Find(&novels).Error; err != nil {
		return nil, 0, err
	}

	return novels, total, nil
}

func (r *novelRepository) ListAll(ctx context.Context) ([]model.Novel, error) {
	var novels []model.Novel
	err := r.db.WithContext(ctx).Order("id ASC").Find(&novels).Error
	return novels, err
}

func (r *novelRepository) Update(ctx context.Context, userID int64, novel *model.Novel) error {
	// Guard the write to the owner's row; never allow reassigning user_id.
	novel.UserID = userID
	return r.db.WithContext(ctx).
		Model(novel).
		Where("user_id = ?", userID).
		Save(novel).Error
}

func (r *novelRepository) Delete(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Delete(&model.Novel{}, id).Error
}
