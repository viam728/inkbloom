package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// OutlineVersionRepository defines data access for agent-taken outline
// snapshots. Every method is scoped by userID (contract C3).
type OutlineVersionRepository interface {
	// Create inserts a new outline snapshot.
	Create(ctx context.Context, v *model.OutlineVersion) error
	// PruneAuto keeps only the newest `keep` agent_auto snapshots for the
	// user+novel, deleting strictly older rows. Returns the number deleted.
	PruneAuto(ctx context.Context, userID, novelID int64, keep int) (int64, error)
}

type outlineVersionRepository struct {
	db *gorm.DB
}

// NewOutlineVersionRepository creates a new OutlineVersionRepository.
func NewOutlineVersionRepository(db *gorm.DB) OutlineVersionRepository {
	return &outlineVersionRepository{db: db}
}

func (r *outlineVersionRepository) Create(ctx context.Context, v *model.OutlineVersion) error {
	return r.db.WithContext(ctx).Create(v).Error
}

// PruneAuto deletes all but the newest `keep` agent_auto snapshots of a
// user+novel.
//
// It resolves the retention boundary first and deletes strictly older rows
// instead of a "NOT IN (subquery with LIMIT)" form: correlated subqueries over
// the same table behave inconsistently between PostgreSQL and SQLite, and the
// construction plan (contract C11) requires both dialects to work. Rows sharing
// the boundary timestamp are kept, erring on the side of not deleting data.
func (r *outlineVersionRepository) PruneAuto(ctx context.Context, userID, novelID int64, keep int) (int64, error) {
	if keep <= 0 {
		keep = 50
	}
	var total int64
	if err := r.db.WithContext(ctx).
		Model(&model.OutlineVersion{}).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ? AND kind = ?", novelID, model.VersionKindAgentAuto).
		Count(&total).Error; err != nil {
		return 0, err
	}
	if total <= int64(keep) {
		return 0, nil
	}

	var boundary model.OutlineVersion
	if err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ? AND kind = ?", novelID, model.VersionKindAgentAuto).
		Select("id, created_at").
		Order("created_at DESC").
		Offset(keep - 1).
		Limit(1).
		First(&boundary).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}

	res := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ? AND kind = ? AND created_at < ?",
			novelID, model.VersionKindAgentAuto, boundary.CreatedAt).
		Delete(&model.OutlineVersion{})
	return res.RowsAffected, res.Error
}
