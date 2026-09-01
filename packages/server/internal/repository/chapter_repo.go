package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrReorderIDMismatch is returned when the provided chapter ids do not fully
// belong to the target novel (missing, soft-deleted or cross-novel ids).
var ErrReorderIDMismatch = errors.New("chapter ids do not match the novel")

// ChapterRepository defines the interface for chapter data access. Every
// method is scoped by userID (M1 isolation).
type ChapterRepository interface {
	Create(ctx context.Context, chapter *model.Chapter) error
	GetByID(ctx context.Context, userID, id int64) (*model.Chapter, error)
	ListByNovelID(ctx context.Context, userID, novelID int64) ([]model.Chapter, error)
	Update(ctx context.Context, userID int64, chapter *model.Chapter) error
	// UpsertWithID inserts a chapter under the explicit primary key it
	// already carries, reviving a soft-deleted row that still holds that id.
	// Needed by the Q3 whole-novel restore so a chapter deleted after the
	// snapshot comes back with its original id — outline nodes reference
	// chapters through chapter_id, so a fresh id would break the links.
	UpsertWithID(ctx context.Context, userID int64, chapter *model.Chapter) error
	Delete(ctx context.Context, userID, id int64) error
	DeleteByNovelID(ctx context.Context, userID, novelID int64) error
	GetMaxPosition(ctx context.Context, userID, novelID int64) (int, error)
	CreateAtPosition(ctx context.Context, userID int64, chapter *model.Chapter, position int) error
	ReorderByIDs(ctx context.Context, userID, novelID int64, ids []int64) error
	RefreshNovelWordCount(ctx context.Context, userID, novelID int64) error
}

// chapterRepository is the GORM implementation of ChapterRepository.
type chapterRepository struct {
	db *gorm.DB
}

// NewChapterRepository creates a new ChapterRepository backed by GORM.
func NewChapterRepository(db *gorm.DB) ChapterRepository {
	return &chapterRepository{db: db}
}

func (r *chapterRepository) Create(ctx context.Context, chapter *model.Chapter) error {
	return r.db.WithContext(ctx).Create(chapter).Error
}

func (r *chapterRepository) GetByID(ctx context.Context, userID, id int64) (*model.Chapter, error) {
	var chapter model.Chapter
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		First(&chapter, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &chapter, nil
}

func (r *chapterRepository) ListByNovelID(ctx context.Context, userID, novelID int64) ([]model.Chapter, error) {
	var chapters []model.Chapter
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Order("position ASC").
		Find(&chapters).Error
	if err != nil {
		return nil, err
	}
	return chapters, nil
}

func (r *chapterRepository) Update(ctx context.Context, userID int64, chapter *model.Chapter) error {
	chapter.UserID = userID
	return r.db.WithContext(ctx).
		Model(chapter).
		Where("user_id = ?", userID).
		Save(chapter).Error
}

// UpsertWithID see the interface comment. Two-step by necessity: Delete only
// sets deleted_at, so the row keeps occupying its primary key and a plain
// INSERT would collide with it. Reviving the existing row is also the more
// faithful restore — created_at and any other untouched column survive.
func (r *chapterRepository) UpsertWithID(ctx context.Context, userID int64, chapter *model.Chapter) error {
	chapter.UserID = userID
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Unscoped().
			Model(&model.Chapter{}).
			Where("id = ? AND user_id = ? AND deleted_at IS NOT NULL", chapter.ID, userID).
			Updates(map[string]interface{}{
				"novel_id":     chapter.NovelID,
				"volume_id":    chapter.VolumeID,
				"title":        chapter.Title,
				"content":      chapter.Content,
				"content_json": chapter.ContentJSON,
				"summary":      chapter.Summary,
				"status":       chapter.Status,
				"word_count":   chapter.WordCount,
				"position":     chapter.Position,
				"deleted_at":   gorm.Expr("NULL"),
				"updated_at":   time.Now(),
			})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected > 0 {
			return nil // revived the soft-deleted row
		}
		return tx.Create(chapter).Error
	})
}

func (r *chapterRepository) Delete(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Delete(&model.Chapter{}, id).Error
}

func (r *chapterRepository) DeleteByNovelID(ctx context.Context, userID, novelID int64) error {
	return r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Delete(&model.Chapter{}).Error
}

func (r *chapterRepository) GetMaxPosition(ctx context.Context, userID, novelID int64) (int, error) {
	var maxPos int
	err := r.db.WithContext(ctx).
		Model(&model.Chapter{}).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Select("COALESCE(MAX(position), 0)").
		Scan(&maxPos).Error
	return maxPos, err
}

// CreateAtPosition inserts a chapter at the given 0-based position within a
// single transaction: non-soft-deleted chapters at or after that position are
// shifted by one first, then the new chapter is inserted.
//
// The shift uses the same two-phase negative-sentinel scheme as ReorderByIDs.
// A single-statement `SET position = position + 1` is NOT viable: the partial
// unique index uniq_chapters_novel_position is non-deferrable, so PostgreSQL
// validates it row-by-row during statement execution, and adjacent increments
// (e.g. 1->2 while a row still holds 2) deterministically hit 23505.
func (r *chapterRepository) CreateAtPosition(ctx context.Context, userID int64, chapter *model.Chapter, position int) error {
	chapter.UserID = userID
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Phase 1: move rows to be shifted (position >= target) to negative
		// sentinel values (-position-1). The mapping is injective and cannot
		// collide with any non-negative position still held by other rows.
		if err := tx.Model(&model.Chapter{}).
			Where("user_id = ? AND novel_id = ? AND position >= ?", userID, chapter.NovelID, position).
			UpdateColumn("position", gorm.Expr("-position - 1")).Error; err != nil {
			return err
		}

		// Phase 2: restore the shifted rows to their final values. A row with
		// sentinel s = -p-1 gets final position p+1 = -s. Final values are all
		// >= position+1, distinct, and cannot collide with untouched rows
		// (which hold 0..position-1).
		if err := tx.Model(&model.Chapter{}).
			Where("user_id = ? AND novel_id = ? AND position < 0", userID, chapter.NovelID).
			UpdateColumn("position", gorm.Expr("-position")).Error; err != nil {
			return err
		}

		chapter.Position = position
		return tx.Create(chapter).Error
	})
}

// ReorderByIDs rewrites chapter positions to 0..len(ids)-1 following the
// given id order, inside a single transaction. The user_id + novel_id guards
// on every update prevent cross-user / cross-novel tampering.
func (r *chapterRepository) ReorderByIDs(ctx context.Context, userID, novelID int64, ids []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock the target chapter rows for the duration of the transaction.
		var locked []int64
		if err := tx.Model(&model.Chapter{}).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND novel_id = ? AND id IN ?", userID, novelID, ids).
			Pluck("id", &locked).Error; err != nil {
			return err
		}
		if len(locked) != len(ids) {
			return ErrReorderIDMismatch
		}

		// Phase 1: move affected rows to negative sentinel positions so the
		// per-row final assignments never hit the partial unique index.
		if err := tx.Model(&model.Chapter{}).
			Where("user_id = ? AND novel_id = ? AND id IN ?", userID, novelID, ids).
			UpdateColumn("position", gorm.Expr("-position - 1")).Error; err != nil {
			return err
		}

		// Phase 2: assign final positions following the requested order.
		for i, id := range ids {
			res := tx.Model(&model.Chapter{}).
				Where("id = ? AND novel_id = ? AND user_id = ?", id, novelID, userID).
				Updates(map[string]interface{}{
					"position":   i,
					"updated_at": time.Now(),
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return ErrReorderIDMismatch
			}
		}
		return nil
	})
}

// RefreshNovelWordCount recomputes novels.word_count from the SQL aggregate
// of its non-soft-deleted chapters. The update is guarded by user_id so a
// stale novel id can never rewrite another user's counter.
func (r *chapterRepository) RefreshNovelWordCount(ctx context.Context, userID, novelID int64) error {
	return r.db.WithContext(ctx).
		Model(&model.Novel{}).
		Where("id = ? AND user_id = ?", novelID, userID).
		UpdateColumn("word_count", gorm.Expr(
			"(SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ? AND user_id = ? AND deleted_at IS NULL)",
			novelID, userID,
		)).Error
}
