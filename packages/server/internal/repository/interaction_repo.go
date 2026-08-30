package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// InteractionRepository persists reader interactions (plan A28).
//
// Reads are cross-user and public (like PublishedReadRepository): comments and
// moods are readable by anyone viewing the published chapter, so there is no
// userID scope on List/Get. Writes carry the authoring reader's userID.
type InteractionRepository interface {
	Create(ctx context.Context, i *model.Interaction) error
	// ListByChapter returns visible (non-hidden) interactions for a published
	// chapter, optionally filtered by type. Ordered by block then time.
	ListByChapter(ctx context.Context, chapterID int64, typeFilter string) ([]model.Interaction, error)
	GetByID(ctx context.Context, id int64) (*model.Interaction, error)
	// UpdateStatus changes an interaction's status (adopt/hide).
	UpdateStatus(ctx context.Context, id int64, status string) error

	// Likes.
	GetVote(ctx context.Context, userID, interactionID int64) (*model.InteractionVote, error)
	UpsertVote(ctx context.Context, v *model.InteractionVote) error
	DeleteVote(ctx context.Context, userID, interactionID int64) error
	// ListLikedIDs returns the interaction ids the user liked within a chapter.
	ListLikedIDs(ctx context.Context, userID, chapterID int64) ([]int64, error)
	IncLikeCount(ctx context.Context, interactionID int64) error
	DecLikeCount(ctx context.Context, interactionID int64) error
}

type interactionRepository struct {
	db *gorm.DB
}

// NewInteractionRepository creates a new InteractionRepository.
func NewInteractionRepository(db *gorm.DB) InteractionRepository {
	return &interactionRepository{db: db}
}

func (r *interactionRepository) Create(ctx context.Context, i *model.Interaction) error {
	return r.db.WithContext(ctx).Create(i).Error
}

func (r *interactionRepository) ListByChapter(ctx context.Context, chapterID int64, typeFilter string) ([]model.Interaction, error) {
	q := r.db.WithContext(ctx).
		Where("chapter_id = ? AND status <> ?", chapterID, model.InteractionStatusHidden)
	if typeFilter != "" {
		q = q.Where("type = ?", typeFilter)
	}
	var list []model.Interaction
	err := q.Order("block_index ASC, created_at ASC").Find(&list).Error
	return list, err
}

func (r *interactionRepository) GetByID(ctx context.Context, id int64) (*model.Interaction, error) {
	var i model.Interaction
	err := r.db.WithContext(ctx).First(&i, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &i, nil
}

func (r *interactionRepository) UpdateStatus(ctx context.Context, id int64, status string) error {
	return r.db.WithContext(ctx).Model(&model.Interaction{}).
		Where("id = ?", id).Update("status", status).Error
}

func (r *interactionRepository) GetVote(ctx context.Context, userID, interactionID int64) (*model.InteractionVote, error) {
	var v model.InteractionVote
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND interaction_id = ?", userID, interactionID).
		First(&v).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (r *interactionRepository) UpsertVote(ctx context.Context, v *model.InteractionVote) error {
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "interaction_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(v).Error
}

func (r *interactionRepository) DeleteVote(ctx context.Context, userID, interactionID int64) error {
	return r.db.WithContext(ctx).
		Where("user_id = ? AND interaction_id = ?", userID, interactionID).
		Delete(&model.InteractionVote{}).Error
}

func (r *interactionRepository) ListLikedIDs(ctx context.Context, userID, chapterID int64) ([]int64, error) {
	var ids []int64
	err := r.db.WithContext(ctx).Model(&model.InteractionVote{}).
		Joins("JOIN interactions ON interactions.id = interaction_votes.interaction_id").
		Where("interaction_votes.user_id = ? AND interactions.chapter_id = ?", userID, chapterID).
		Pluck("interaction_votes.interaction_id", &ids).Error
	return ids, err
}

func (r *interactionRepository) IncLikeCount(ctx context.Context, interactionID int64) error {
	return r.db.WithContext(ctx).Model(&model.Interaction{}).
		Where("id = ?", interactionID).
		UpdateColumn("like_count", gorm.Expr("like_count + 1")).Error
}

func (r *interactionRepository) DecLikeCount(ctx context.Context, interactionID int64) error {
	return r.db.WithContext(ctx).Model(&model.Interaction{}).
		Where("id = ?", interactionID).
		UpdateColumn("like_count", gorm.Expr("GREATEST(like_count - 1, 0)")).Error
}
