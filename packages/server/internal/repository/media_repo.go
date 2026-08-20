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

// ErrMediaReorderIDMismatch is returned when the provided content ids do not
// fully cover the live (non-soft-deleted) media contents set.
var ErrMediaReorderIDMismatch = errors.New("media content ids do not match")

// MediaRepository defines the interface for media content & topic data
// access. All operations are scoped by user_id (M1 isolation).
type MediaRepository interface {
	// Contents
	ListContents(ctx context.Context, userID int64) ([]model.MediaContent, error)
	GetContentByID(ctx context.Context, userID, id int64) (*model.MediaContent, error)
	CreateContent(ctx context.Context, content *model.MediaContent) error
	UpdateContent(ctx context.Context, userID int64, content *model.MediaContent) error
	DeleteContent(ctx context.Context, userID, id int64) error
	ReorderContents(ctx context.Context, userID int64, ids []int64) error

	// Topics
	ListTopics(ctx context.Context, userID int64) ([]model.MediaTopic, error)
	ReplaceTopics(ctx context.Context, userID int64, topics []model.MediaTopic) error

	// Memory
	// GetMediaMemory returns the memory document of the given user. When no
	// row exists, an empty document (items = [], version = 0) is returned
	// instead of an error.
	GetMediaMemory(ctx context.Context, userID int64) (*model.MediaMemory, error)
	// UpsertMediaMemory inserts or wholesale-replaces the user's memory
	// document (PK user_id). On conflict the version is incremented and
	// updated_at refreshed; the document is populated with the resulting
	// version/updated_at via RETURNING.
	UpsertMediaMemory(ctx context.Context, doc *model.MediaMemory) error
}

// mediaRepository is the GORM implementation of MediaRepository.
type mediaRepository struct {
	db *gorm.DB
}

// NewMediaRepository creates a new MediaRepository backed by GORM.
func NewMediaRepository(db *gorm.DB) MediaRepository {
	return &mediaRepository{db: db}
}

// ListContents returns all non-soft-deleted contents of the user ordered
// by position ASC.
func (r *mediaRepository) ListContents(ctx context.Context, userID int64) ([]model.MediaContent, error) {
	var contents []model.MediaContent
	if err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Order("position ASC").
		Find(&contents).Error; err != nil {
		return nil, err
	}
	return contents, nil
}

// GetContentByID returns a content by id, or nil when not found /
// soft-deleted / owned by another user.
func (r *mediaRepository) GetContentByID(ctx context.Context, userID, id int64) (*model.MediaContent, error) {
	var content model.MediaContent
	if err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).First(&content, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &content, nil
}

// CreateContent appends a content at max(position)+1 inside a transaction.
// All live rows are row-locked first so concurrent creates never derive the
// same position (media_contents has no unique index on position, so the lock
// is the only serialization point).
func (r *mediaRepository) CreateContent(ctx context.Context, content *model.MediaContent) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var maxPos *int
		// Lock the user's live rows for the duration of the transaction.
		var pos int
		rows, err := tx.Model(&model.MediaContent{}).
			Scopes(scope.ForUser(content.UserID)).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Select("position").
			Rows()
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := rows.Scan(&pos); err != nil {
				return err
			}
			if maxPos == nil || pos > *maxPos {
				maxPos = &pos
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}

		next := 0
		if maxPos != nil {
			next = *maxPos + 1
		}
		content.Position = next
		return tx.Create(content).Error
	})
}

// UpdateContent persists a full model row (callers apply partial patches on
// the loaded model before saving). The user_id guard prevents cross-user
// mutation even if callers pass a tampered model.
func (r *mediaRepository) UpdateContent(ctx context.Context, userID int64, content *model.MediaContent) error {
	content.UserID = userID
	return r.db.WithContext(ctx).
		Model(content).
		Where("user_id = ?", userID).
		Save(content).Error
}

// DeleteContent soft-deletes a content by id within the user's scope.
func (r *mediaRepository) DeleteContent(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Delete(&model.MediaContent{}, id).Error
}

// ReorderContents rewrites positions to 0..len(ids)-1 following the given id
// order, inside a single transaction. media_contents has no unique index on
// position, so per-row updates are safe without a negative-sentinel phase;
// the transaction keeps the rewrite atomic.
func (r *mediaRepository) ReorderContents(ctx context.Context, userID int64, ids []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock and count the user's live rows: the id list must exactly
		// cover them.
		var locked []int64
		if err := tx.Model(&model.MediaContent{}).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Scopes(scope.ForUser(userID)).
			Where("id IN ?", ids).
			Pluck("id", &locked).Error; err != nil {
			return err
		}
		var total int64
		if err := tx.Model(&model.MediaContent{}).Scopes(scope.ForUser(userID)).Count(&total).Error; err != nil {
			return err
		}
		if len(locked) != len(ids) || int(total) != len(ids) {
			return ErrMediaReorderIDMismatch
		}

		for i, id := range ids {
			res := tx.Model(&model.MediaContent{}).
				Scopes(scope.ForUser(userID)).
				Where("id = ?", id).
				Updates(map[string]interface{}{
					"position":   i,
					"updated_at": time.Now(),
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return ErrMediaReorderIDMismatch
			}
		}
		return nil
	})
}

// ListTopics returns all topics of the user ordered by position ASC.
func (r *mediaRepository) ListTopics(ctx context.Context, userID int64) ([]model.MediaTopic, error) {
	var topics []model.MediaTopic
	if err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Order("position ASC").
		Find(&topics).Error; err != nil {
		return nil, err
	}
	return topics, nil
}

// ReplaceTopics atomically replaces the user's whole topic set: DELETE the
// user's rows then bulk-insert the given list, preserving array order as
// position 0..n-1. Idempotent: identical payloads converge to the same state.
func (r *mediaRepository) ReplaceTopics(ctx context.Context, userID int64, topics []model.MediaTopic) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Scopes(scope.ForUser(userID)).
			Session(&gorm.Session{AllowGlobalUpdate: true}).
			Delete(&model.MediaTopic{}).Error; err != nil {
			return err
		}
		if len(topics) == 0 {
			return nil
		}
		for i := range topics {
			topics[i].Position = i
			topics[i].UserID = userID
		}
		return tx.CreateInBatches(topics, 100).Error
	})
}

// GetMediaMemory returns the user's memory row (keyed by user_id), or an
// empty document when the user has no row yet.
func (r *mediaRepository) GetMediaMemory(ctx context.Context, userID int64) (*model.MediaMemory, error) {
	var doc model.MediaMemory
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&doc).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.MediaMemory{UserID: userID, Items: emptyJSONArray}, nil
		}
		return nil, err
	}
	return &doc, nil
}

// UpsertMediaMemory inserts or wholesale-replaces the user's memory row with
// the same conflict semantics as NovelDocRepository.UpsertMemory; the
// conflict target is the user_id primary key.
func (r *mediaRepository) UpsertMediaMemory(ctx context.Context, doc *model.MediaMemory) error {
	return r.db.WithContext(ctx).
		Clauses(
			clause.OnConflict{
				Columns: []clause.Column{{Name: "user_id"}},
				DoUpdates: clause.Assignments(map[string]interface{}{
					"items": doc.Items,
					// Table-qualified self-reference: bare "version + 1" is ambiguous
					// in PG's ON CONFLICT DO UPDATE (target row vs excluded), SQLSTATE 42702.
					"version":    gorm.Expr("media_memory.version + 1"),
					"updated_at": time.Now(),
				}),
			},
			clause.Returning{Columns: []clause.Column{{Name: "version"}, {Name: "updated_at"}}},
		).
		Create(doc).Error
}
