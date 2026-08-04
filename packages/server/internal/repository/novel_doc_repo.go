package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// emptyJSONArray is the canonical empty payload for outline/memory documents.
var emptyJSONArray = []byte("[]")

// NovelDocRepository defines data access for per-novel document tables
// (novel_outline / novel_memory) plus the novel deletion cascade.
type NovelDocRepository interface {
	// GetOutline returns the outline document for a novel. When no row
	// exists, an empty document (acts = [], version = 0) is returned
	// instead of an error.
	GetOutline(ctx context.Context, novelID int64) (*model.NovelOutline, error)
	// GetMemory returns the memory document for a novel. When no row
	// exists, an empty document (items = [], version = 0) is returned
	// instead of an error.
	GetMemory(ctx context.Context, novelID int64) (*model.NovelMemory, error)
	// UpsertOutline inserts or wholesale-replaces the outline. On conflict
	// the version is incremented and updated_at refreshed; the document is
	// populated with the resulting version/updated_at via RETURNING.
	UpsertOutline(ctx context.Context, doc *model.NovelOutline) error
	// UpsertMemory inserts or wholesale-replaces the memory document with
	// the same conflict semantics as UpsertOutline.
	UpsertMemory(ctx context.Context, doc *model.NovelMemory) error
	// CascadeDeleteNovel removes everything owned by a novel in a single
	// transaction: soft-deletes chapters and the novel itself, and
	// hard-deletes the novel_outline / novel_memory rows.
	CascadeDeleteNovel(ctx context.Context, novelID int64) error
}

// novelDocRepository is the GORM implementation of NovelDocRepository.
type novelDocRepository struct {
	db *gorm.DB
}

// NewNovelDocRepository creates a new NovelDocRepository backed by GORM.
func NewNovelDocRepository(db *gorm.DB) NovelDocRepository {
	return &novelDocRepository{db: db}
}

func (r *novelDocRepository) GetOutline(ctx context.Context, novelID int64) (*model.NovelOutline, error) {
	var doc model.NovelOutline
	err := r.db.WithContext(ctx).Where("novel_id = ?", novelID).First(&doc).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.NovelOutline{NovelID: novelID, Acts: emptyJSONArray}, nil
		}
		return nil, err
	}
	return &doc, nil
}

func (r *novelDocRepository) GetMemory(ctx context.Context, novelID int64) (*model.NovelMemory, error) {
	var doc model.NovelMemory
	err := r.db.WithContext(ctx).Where("novel_id = ?", novelID).First(&doc).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.NovelMemory{NovelID: novelID, Items: emptyJSONArray}, nil
		}
		return nil, err
	}
	return &doc, nil
}

func (r *novelDocRepository) UpsertOutline(ctx context.Context, doc *model.NovelOutline) error {
	return r.db.WithContext(ctx).
		Clauses(
			clause.OnConflict{
				Columns: []clause.Column{{Name: "novel_id"}},
				DoUpdates: clause.Assignments(map[string]interface{}{
					"acts":       doc.Acts,
					"version":    gorm.Expr("novel_outline.version + 1"),
					"updated_at": gorm.Expr("now()"),
				}),
			},
			clause.Returning{Columns: []clause.Column{{Name: "version"}, {Name: "updated_at"}}},
		).
		Create(doc).Error
}

func (r *novelDocRepository) UpsertMemory(ctx context.Context, doc *model.NovelMemory) error {
	return r.db.WithContext(ctx).
		Clauses(
			clause.OnConflict{
				Columns: []clause.Column{{Name: "novel_id"}},
				DoUpdates: clause.Assignments(map[string]interface{}{
					"items":      doc.Items,
					"version":    gorm.Expr("novel_memory.version + 1"),
					"updated_at": gorm.Expr("now()"),
				}),
			},
			clause.Returning{Columns: []clause.Column{{Name: "version"}, {Name: "updated_at"}}},
		).
		Create(doc).Error
}

// CascadeDeleteNovel performs the whole-novel teardown atomically. Chapters
// and the novel carry DeletedAt so GORM soft-deletes them; the outline and
// memory models have no DeletedAt field, so they are hard-deleted.
func (r *novelDocRepository) CascadeDeleteNovel(ctx context.Context, novelID int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("novel_id = ?", novelID).Delete(&model.Chapter{}).Error; err != nil {
			return err
		}
		if err := tx.Where("novel_id = ?", novelID).Delete(&model.NovelOutline{}).Error; err != nil {
			return err
		}
		if err := tx.Where("novel_id = ?", novelID).Delete(&model.NovelMemory{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Novel{}, novelID).Error
	})
}
