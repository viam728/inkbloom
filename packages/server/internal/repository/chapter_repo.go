package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrReorderIDMismatch is returned when the provided chapter ids do not fully
// belong to the target novel (missing, soft-deleted or cross-novel ids).
var ErrReorderIDMismatch = errors.New("chapter ids do not match the novel")

// ChapterRepository defines the interface for chapter data access.
type ChapterRepository interface {
	Create(ctx context.Context, chapter *model.Chapter) error
	GetByID(ctx context.Context, id int64) (*model.Chapter, error)
	ListByNovelID(ctx context.Context, novelID int64) ([]model.Chapter, error)
	Update(ctx context.Context, chapter *model.Chapter) error
	Delete(ctx context.Context, id int64) error
	DeleteByNovelID(ctx context.Context, novelID int64) error
	GetMaxPosition(ctx context.Context, novelID int64) (int, error)
	CreateAtPosition(ctx context.Context, chapter *model.Chapter, position int) error
	ReorderByIDs(ctx context.Context, novelID int64, ids []int64) error
	RefreshNovelWordCount(ctx context.Context, novelID int64) error
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

func (r *chapterRepository) GetByID(ctx context.Context, id int64) (*model.Chapter, error) {
	var chapter model.Chapter
	if err := r.db.WithContext(ctx).First(&chapter, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &chapter, nil
}

func (r *chapterRepository) ListByNovelID(ctx context.Context, novelID int64) ([]model.Chapter, error) {
	var chapters []model.Chapter
	if err := r.db.WithContext(ctx).
		Where("novel_id = ?", novelID).
		Order("position ASC").
		Find(&chapters).Error; err != nil {
		return nil, err
	}
	return chapters, nil
}

func (r *chapterRepository) Update(ctx context.Context, chapter *model.Chapter) error {
	return r.db.WithContext(ctx).Save(chapter).Error
}

func (r *chapterRepository) Delete(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&model.Chapter{}, id).Error
}

func (r *chapterRepository) DeleteByNovelID(ctx context.Context, novelID int64) error {
	return r.db.WithContext(ctx).Where("novel_id = ?", novelID).Delete(&model.Chapter{}).Error
}

func (r *chapterRepository) GetMaxPosition(ctx context.Context, novelID int64) (int, error) {
	var maxPos int
	err := r.db.WithContext(ctx).
		Model(&model.Chapter{}).
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
func (r *chapterRepository) CreateAtPosition(ctx context.Context, chapter *model.Chapter, position int) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Phase 1: move rows to be shifted (position >= target) to negative
		// sentinel values (-position-1). The mapping is injective and cannot
		// collide with any non-negative position still held by other rows.
		if err := tx.Model(&model.Chapter{}).
			Where("novel_id = ? AND position >= ?", chapter.NovelID, position).
			UpdateColumn("position", gorm.Expr("-position - 1")).Error; err != nil {
			return err
		}

		// Phase 2: restore the shifted rows to their final values. A row with
		// sentinel s = -p-1 gets final position p+1 = -s. Final values are all
		// >= position+1, distinct, and cannot collide with untouched rows
		// (which hold 0..position-1).
		if err := tx.Model(&model.Chapter{}).
			Where("novel_id = ? AND position < 0", chapter.NovelID).
			UpdateColumn("position", gorm.Expr("-position")).Error; err != nil {
			return err
		}

		chapter.Position = position
		return tx.Create(chapter).Error
	})
}

// ReorderByIDs rewrites chapter positions to 0..len(ids)-1 following the
// given id order, inside a single transaction. The novel_id guard on every
// update prevents cross-novel tampering.
func (r *chapterRepository) ReorderByIDs(ctx context.Context, novelID int64, ids []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock the target chapter rows for the duration of the transaction.
		var locked []int64
		if err := tx.Model(&model.Chapter{}).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("novel_id = ? AND id IN ?", novelID, ids).
			Pluck("id", &locked).Error; err != nil {
			return err
		}
		if len(locked) != len(ids) {
			return ErrReorderIDMismatch
		}

		// Phase 1: move affected rows to negative sentinel positions so the
		// per-row final assignments never hit the partial unique index.
		if err := tx.Model(&model.Chapter{}).
			Where("novel_id = ? AND id IN ?", novelID, ids).
			UpdateColumn("position", gorm.Expr("-position - 1")).Error; err != nil {
			return err
		}

		// Phase 2: assign final positions following the requested order.
		for i, id := range ids {
			res := tx.Model(&model.Chapter{}).
				Where("id = ? AND novel_id = ?", id, novelID).
				Updates(map[string]interface{}{
					"position":   i,
					"updated_at": gorm.Expr("now()"),
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
// of its non-soft-deleted chapters.
func (r *chapterRepository) RefreshNovelWordCount(ctx context.Context, novelID int64) error {
	return r.db.WithContext(ctx).
		Model(&model.Novel{}).
		Where("id = ?", novelID).
		UpdateColumn("word_count", gorm.Expr(
			"(SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ? AND deleted_at IS NULL)",
			novelID,
		)).Error
}
