package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// ForeshadowRepository defines the interface for foreshadow thread access.
// Every method is scoped by userID (contract C3).
type ForeshadowRepository interface {
	Create(ctx context.Context, f *model.Foreshadow) error
	GetByID(ctx context.Context, userID, id int64) (*model.Foreshadow, error)
	ListByNovel(ctx context.Context, userID, novelID int64) ([]model.Foreshadow, error)
	// ListByStatus returns threads of one novel in the given statuses,
	// ordered so the most urgent payoff comes first.
	ListByStatus(ctx context.Context, userID, novelID int64, statuses []string) ([]model.Foreshadow, error)
	Update(ctx context.Context, userID int64, f *model.Foreshadow) error
	Delete(ctx context.Context, userID, id int64) error
}

type foreshadowRepository struct {
	db *gorm.DB
}

// NewForeshadowRepository creates a new ForeshadowRepository.
func NewForeshadowRepository(db *gorm.DB) ForeshadowRepository {
	return &foreshadowRepository{db: db}
}

func (r *foreshadowRepository) Create(ctx context.Context, f *model.Foreshadow) error {
	return r.db.WithContext(ctx).Create(f).Error
}

func (r *foreshadowRepository) GetByID(ctx context.Context, userID, id int64) (*model.Foreshadow, error) {
	var f model.Foreshadow
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		First(&f, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &f, nil
}

func (r *foreshadowRepository) ListByNovel(ctx context.Context, userID, novelID int64) ([]model.Foreshadow, error) {
	var list []model.Foreshadow
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Order("updated_at DESC").
		Find(&list).Error
	return list, err
}

// ListByStatus orders pending threads by their expected payoff position.
//
// expect_chapter is nullable and NULL sorts last in PostgreSQL... but FIRST in
// SQLite. NULLS LAST is not portable across the two dialects (contract C11),
// so "no expectation" is coalesced to a large sentinel that sorts last in
// both, and equal priorities fall back to creation order.
func (r *foreshadowRepository) ListByStatus(ctx context.Context, userID, novelID int64, statuses []string) ([]model.Foreshadow, error) {
	var list []model.Foreshadow
	query := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID)
	if len(statuses) > 0 {
		query = query.Where("status IN ?", statuses)
	}
	err := query.
		Order("COALESCE(expect_chapter, 2147483647) ASC, created_at ASC").
		Find(&list).Error
	return list, err
}

func (r *foreshadowRepository) Update(ctx context.Context, userID int64, f *model.Foreshadow) error {
	f.UpdatedAt = time.Now()
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Save(f).Error
}

func (r *foreshadowRepository) Delete(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Delete(&model.Foreshadow{}, id).Error
}
