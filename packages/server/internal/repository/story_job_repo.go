package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// ErrStoryJobNotFound is returned when a story job does not exist or is not
// owned by the requesting user.
var ErrStoryJobNotFound = errors.New("story job not found")

// StoryJobRepository defines data access for the Agent full-book creation
// pipeline (story_jobs). All operations are scoped by user_id (M1 isolation).
type StoryJobRepository interface {
	Create(ctx context.Context, job *model.StoryJob) error
	GetByID(ctx context.Context, userID, id int64) (*model.StoryJob, error)
	ListByNovel(ctx context.Context, userID, novelID int64) ([]model.StoryJob, error)
	// ListByUser returns the user's creation jobs paginated by updated_at.
	ListByUser(ctx context.Context, userID int64, page, pageSize int) ([]model.StoryJob, int64, error)
	// Update persists job fields (stage/status/progress/stage_payload/...).
	Update(ctx context.Context, job *model.StoryJob) error
	Delete(ctx context.Context, userID, id int64) error
}

// storyJobRepository is the GORM implementation of StoryJobRepository.
type storyJobRepository struct {
	db *gorm.DB
}

// NewStoryJobRepository creates a new StoryJobRepository backed by GORM.
func NewStoryJobRepository(db *gorm.DB) StoryJobRepository {
	return &storyJobRepository{db: db}
}

func (r *storyJobRepository) Create(ctx context.Context, job *model.StoryJob) error {
	return r.db.WithContext(ctx).Create(job).Error
}

func (r *storyJobRepository) GetByID(ctx context.Context, userID, id int64) (*model.StoryJob, error) {
	var job model.StoryJob
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("id = ?", id).First(&job).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrStoryJobNotFound
		}
		return nil, err
	}
	return &job, nil
}

func (r *storyJobRepository) ListByNovel(ctx context.Context, userID, novelID int64) ([]model.StoryJob, error) {
	var jobs []model.StoryJob
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).
		Order("updated_at DESC").Find(&jobs).Error
	return jobs, err
}

func (r *storyJobRepository) ListByUser(ctx context.Context, userID int64, page, pageSize int) ([]model.StoryJob, int64, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 20
	}
	var count int64
	q := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Model(&model.StoryJob{})
	if err := q.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	var jobs []model.StoryJob
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Order("updated_at DESC").Limit(pageSize).Offset((page - 1) * pageSize).Find(&jobs).Error
	return jobs, count, err
}

func (r *storyJobRepository) Update(ctx context.Context, job *model.StoryJob) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(job.UserID)).Model(job).Save(job).Error
}

func (r *storyJobRepository) Delete(ctx context.Context, userID, id int64) error {
	res := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Delete(&model.StoryJob{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrStoryJobNotFound
	}
	return nil
}
