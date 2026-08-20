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

// emptyJSONArray is the canonical empty payload for outline/memory documents.
var emptyJSONArray = []byte("[]")

// NovelDocRepository defines data access for per-novel document tables
// (novel_outline / novel_memory) plus the novel deletion cascade. All
// operations are scoped by user_id (M1 isolation).
type NovelDocRepository interface {
	// GetOutline returns the outline document for a novel. When no row
	// exists, an empty document (acts = [], version = 0) is returned
	// instead of an error.
	GetOutline(ctx context.Context, userID, novelID int64) (*model.NovelOutline, error)
	// GetMemory returns the memory document for a novel. When no row
	// exists, an empty document (items = [], version = 0) is returned
	// instead of an error.
	GetMemory(ctx context.Context, userID, novelID int64) (*model.NovelMemory, error)
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
	CascadeDeleteNovel(ctx context.Context, userID, novelID int64) error
}

// novelDocRepository is the GORM implementation of NovelDocRepository.
type novelDocRepository struct {
	db *gorm.DB
}

// NewNovelDocRepository creates a new NovelDocRepository backed by GORM.
func NewNovelDocRepository(db *gorm.DB) NovelDocRepository {
	return &novelDocRepository{db: db}
}

func (r *novelDocRepository) GetOutline(ctx context.Context, userID, novelID int64) (*model.NovelOutline, error) {
	var doc model.NovelOutline
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).First(&doc).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.NovelOutline{UserID: userID, NovelID: novelID, Acts: emptyJSONArray}, nil
		}
		return nil, err
	}
	return &doc, nil
}

func (r *novelDocRepository) GetMemory(ctx context.Context, userID, novelID int64) (*model.NovelMemory, error) {
	var doc model.NovelMemory
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).First(&doc).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.NovelMemory{UserID: userID, NovelID: novelID, Items: emptyJSONArray}, nil
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
					"acts": doc.Acts,
					// Table-qualified self-reference: bare "version + 1" is ambiguous
					// in PG's ON CONFLICT DO UPDATE (target row vs excluded), SQLSTATE 42702.
					"version":    gorm.Expr("novel_outline.version + 1"),
					"updated_at": time.Now(),
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
					"items": doc.Items,
					// Table-qualified self-reference; see UpsertOutline for rationale.
					"version":    gorm.Expr("novel_memory.version + 1"),
					"updated_at": time.Now(),
				}),
			},
			clause.Returning{Columns: []clause.Column{{Name: "version"}, {Name: "updated_at"}}},
		).
		Create(doc).Error
}

// CascadeDeleteNovel performs the whole-novel teardown atomically. Chapters
// and the novel carry DeletedAt so GORM soft-deletes them; the outline and
// memory models have no DeletedAt field, so they are hard-deleted. Every
// statement is additionally guarded by user_id so the cascade can never
// touch another user's rows.
func (r *novelDocRepository) CascadeDeleteNovel(ctx context.Context, userID, novelID int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Delete(&model.Chapter{}).Error; err != nil {
			return err
		}
		if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Delete(&model.NovelOutline{}).Error; err != nil {
			return err
		}
		if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Delete(&model.NovelMemory{}).Error; err != nil {
			return err
		}
		return tx.Scopes(scope.ForUser(userID)).Delete(&model.Novel{}, novelID).Error
	})
}
