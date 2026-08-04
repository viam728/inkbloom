package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrMediaReorderIDMismatch is returned when the provided content ids do not
// fully cover the live (non-soft-deleted) media contents set.
var ErrMediaReorderIDMismatch = errors.New("media content ids do not match")

// MediaRepository defines the interface for media content & topic data access.
type MediaRepository interface {
	// Contents
	ListContents(ctx context.Context) ([]model.MediaContent, error)
	GetContentByID(ctx context.Context, id int64) (*model.MediaContent, error)
	CreateContent(ctx context.Context, content *model.MediaContent) error
	UpdateContent(ctx context.Context, content *model.MediaContent) error
	DeleteContent(ctx context.Context, id int64) error
	ReorderContents(ctx context.Context, ids []int64) error

	// Topics
	ListTopics(ctx context.Context) ([]model.MediaTopic, error)
	ReplaceTopics(ctx context.Context, topics []model.MediaTopic) error
}

// mediaRepository is the GORM implementation of MediaRepository.
type mediaRepository struct {
	db *gorm.DB
}

// NewMediaRepository creates a new MediaRepository backed by GORM.
func NewMediaRepository(db *gorm.DB) MediaRepository {
	return &mediaRepository{db: db}
}

// ListContents returns all non-soft-deleted contents ordered by position ASC.
func (r *mediaRepository) ListContents(ctx context.Context) ([]model.MediaContent, error) {
	var contents []model.MediaContent
	if err := r.db.WithContext(ctx).
		Order("position ASC").
		Find(&contents).Error; err != nil {
		return nil, err
	}
	return contents, nil
}

// GetContentByID returns a content by id, or nil when not found / soft-deleted.
func (r *mediaRepository) GetContentByID(ctx context.Context, id int64) (*model.MediaContent, error) {
	var content model.MediaContent
	if err := r.db.WithContext(ctx).First(&content, id).Error; err != nil {
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
		// Lock live rows for the duration of the transaction.
		var pos int
		rows, err := tx.Model(&model.MediaContent{}).
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
// the loaded model before saving).
func (r *mediaRepository) UpdateContent(ctx context.Context, content *model.MediaContent) error {
	return r.db.WithContext(ctx).Save(content).Error
}

// DeleteContent soft-deletes a content by id.
func (r *mediaRepository) DeleteContent(ctx context.Context, id int64) error {
	return r.db.WithContext(ctx).Delete(&model.MediaContent{}, id).Error
}

// ReorderContents rewrites positions to 0..len(ids)-1 following the given id
// order, inside a single transaction. media_contents has no unique index on
// position, so per-row updates are safe without a negative-sentinel phase;
// the transaction keeps the rewrite atomic.
func (r *mediaRepository) ReorderContents(ctx context.Context, ids []int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock and count live rows: the id list must exactly cover them.
		var locked []int64
		if err := tx.Model(&model.MediaContent{}).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id IN ?", ids).
			Pluck("id", &locked).Error; err != nil {
			return err
		}
		var total int64
		if err := tx.Model(&model.MediaContent{}).Count(&total).Error; err != nil {
			return err
		}
		if len(locked) != len(ids) || int(total) != len(ids) {
			return ErrMediaReorderIDMismatch
		}

		for i, id := range ids {
			res := tx.Model(&model.MediaContent{}).
				Where("id = ?", id).
				Updates(map[string]interface{}{
					"position":   i,
					"updated_at": gorm.Expr("now()"),
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

// ListTopics returns all topics ordered by position ASC.
func (r *mediaRepository) ListTopics(ctx context.Context) ([]model.MediaTopic, error) {
	var topics []model.MediaTopic
	if err := r.db.WithContext(ctx).
		Order("position ASC").
		Find(&topics).Error; err != nil {
		return nil, err
	}
	return topics, nil
}

// ReplaceTopics atomically replaces the whole topic set: DELETE all rows then
// bulk-insert the given list, preserving array order as position 0..n-1.
// Idempotent: identical payloads converge to the same state.
func (r *mediaRepository) ReplaceTopics(ctx context.Context, topics []model.MediaTopic) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Session(&gorm.Session{AllowGlobalUpdate: true}).
			Delete(&model.MediaTopic{}).Error; err != nil {
			return err
		}
		if len(topics) == 0 {
			return nil
		}
		for i := range topics {
			topics[i].Position = i
		}
		return tx.CreateInBatches(topics, 100).Error
	})
}
