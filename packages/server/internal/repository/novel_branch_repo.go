package repository

import (
	"context"
	"fmt"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// NovelBranchRepository persists world-branch tree nodes.
type NovelBranchRepository interface {
	ListByNovel(ctx context.Context, userID, novelID int64) ([]model.NovelBranch, error)
	GetByID(ctx context.Context, userID, id int64) (*model.NovelBranch, error)
	Create(ctx context.Context, b *model.NovelBranch) error
	Update(ctx context.Context, userID, id int64, updates map[string]any) error
	Delete(ctx context.Context, userID, id int64) error
	// DeleteSubtree removes a node and all its descendants (recursive CTE).
	DeleteSubtree(ctx context.Context, userID, id int64) error
}

type novelBranchRepository struct {
	db *gorm.DB
}

func NewNovelBranchRepository(db *gorm.DB) NovelBranchRepository {
	return &novelBranchRepository{db: db}
}

func (r *novelBranchRepository) ListByNovel(ctx context.Context, userID, novelID int64) ([]model.NovelBranch, error) {
	var list []model.NovelBranch
	if err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Order("created_at ASC, id ASC").
		Find(&list).Error; err != nil {
		return nil, fmt.Errorf("list branches: %w", err)
	}
	return list, nil
}

func (r *novelBranchRepository) GetByID(ctx context.Context, userID, id int64) (*model.NovelBranch, error) {
	var b model.NovelBranch
	if err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("id = ?", id).First(&b).Error; err != nil {
		return nil, fmt.Errorf("get branch %d: %w", id, err)
	}
	return &b, nil
}

func (r *novelBranchRepository) Create(ctx context.Context, b *model.NovelBranch) error {
	if err := r.db.WithContext(ctx).Create(b).Error; err != nil {
		return fmt.Errorf("create branch: %w", err)
	}
	return nil
}

func (r *novelBranchRepository) Update(ctx context.Context, userID, id int64, updates map[string]any) error {
	result := r.db.WithContext(ctx).Model(&model.NovelBranch{}).
		Scopes(scope.ForUser(userID)).
		Where("id = ?", id).
		Updates(updates)
	if result.Error != nil {
		return fmt.Errorf("update branch %d: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("branch %d not found", id)
	}
	return nil
}

func (r *novelBranchRepository) Delete(ctx context.Context, userID, id int64) error {
	result := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Delete(&model.NovelBranch{}, id)
	if result.Error != nil {
		return fmt.Errorf("delete branch %d: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("branch %d not found", id)
	}
	return nil
}

// DeleteSubtree deletes a node plus every descendant. Branch counts are
// small (tens), so the subtree is resolved in memory and deleted by id set —
// simpler and more portable than a recursive CTE through GORM.
func (r *novelBranchRepository) DeleteSubtree(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var list []model.NovelBranch
		if err := tx.Scopes(scope.ForUser(userID)).Find(&list).Error; err != nil {
			return fmt.Errorf("load branches for subtree delete: %w", err)
		}
		// Walk the ownership tree to confirm the node belongs to this user's
		// set (GetByID semantics), then collect descendants breadth-first.
		byID := make(map[int64]model.NovelBranch, len(list))
		children := make(map[int64][]int64)
		var root *model.NovelBranch
		for _, b := range list {
			byID[b.ID] = b
			if b.ParentID != nil {
				children[*b.ParentID] = append(children[*b.ParentID], b.ID)
			}
			if b.ID == id {
				root = &b
			}
		}
		if root == nil {
			return fmt.Errorf("branch %d not found", id)
		}
		ids := []int64{id}
		queue := []int64{id}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			ids = append(ids, children[cur]...)
			queue = append(queue, children[cur]...)
		}
		if err := tx.Where("id IN ?", ids).Delete(&model.NovelBranch{}).Error; err != nil {
			return err
		}
		return nil
	})
}
