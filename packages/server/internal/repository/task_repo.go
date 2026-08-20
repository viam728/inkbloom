package repository

import (
	"context"
	"fmt"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// TaskRepository defines the interface for task persistence operations.
// The unscoped List/GetByID variants serve the background task engine; API
// handlers must use ListByUser plus an ownership check on GetByID results
// (M1 isolation).
type TaskRepository interface {
	Create(ctx context.Context, task *model.Task) error
	GetByID(ctx context.Context, id string) (*model.Task, error)
	UpdateStatus(ctx context.Context, id string, status string) error
	UpdateProgress(ctx context.Context, id string, progress int16) error
	List(ctx context.Context, status string, limit int) ([]model.Task, error)
	ListByUser(ctx context.Context, userID int64, status string, limit int) ([]model.Task, error)
	IncrementRetry(ctx context.Context, id string) error
	GetByIdempotencyKey(ctx context.Context, key string) (*model.Task, error)
}

// taskRepository is the GORM-backed implementation of TaskRepository.
type taskRepository struct {
	db *gorm.DB
}

// NewTaskRepository creates a new TaskRepository.
func NewTaskRepository(db *gorm.DB) TaskRepository {
	return &taskRepository{db: db}
}

func (r *taskRepository) Create(ctx context.Context, task *model.Task) error {
	if err := r.db.WithContext(ctx).Create(task).Error; err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return nil
}

func (r *taskRepository) GetByID(ctx context.Context, id string) (*model.Task, error) {
	var task model.Task
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&task).Error; err != nil {
		return nil, fmt.Errorf("get task %s: %w", id, err)
	}
	return &task, nil
}

func (r *taskRepository) UpdateStatus(ctx context.Context, id string, status string) error {
	result := r.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", id).
		Updates(map[string]interface{}{
			"status":       status,
			"started_at":   gorm.Expr("CASE WHEN ? IN ('running') AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END", status),
			"completed_at": gorm.Expr("CASE WHEN ? IN ('success','failed','dead_letter') THEN CURRENT_TIMESTAMP ELSE completed_at END", status),
		})
	if result.Error != nil {
		return fmt.Errorf("update task status %s: %w", id, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("task %s not found", id)
	}
	return nil
}

func (r *taskRepository) UpdateProgress(ctx context.Context, id string, progress int16) error {
	if err := r.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", id).
		Update("progress", progress).Error; err != nil {
		return fmt.Errorf("update task progress %s: %w", id, err)
	}
	return nil
}

func (r *taskRepository) List(ctx context.Context, status string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	query := r.db.WithContext(ctx).Order("priority DESC, created_at ASC")
	if status != "" {
		query = query.Where("status = ?", status)
	}
	if limit > 0 {
		query = query.Limit(limit)
	} else {
		query = query.Limit(50)
	}
	if err := query.Find(&tasks).Error; err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	return tasks, nil
}

// ListByUser lists tasks owned by a single user (API-facing variant of List;
// the background engine keeps using the unscoped List).
func (r *taskRepository) ListByUser(ctx context.Context, userID int64, status string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	query := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Order("priority DESC, created_at ASC")
	if status != "" {
		query = query.Where("status = ?", status)
	}
	if limit > 0 {
		query = query.Limit(limit)
	} else {
		query = query.Limit(50)
	}
	if err := query.Find(&tasks).Error; err != nil {
		return nil, fmt.Errorf("list tasks by user: %w", err)
	}
	return tasks, nil
}

func (r *taskRepository) GetByIdempotencyKey(ctx context.Context, key string) (*model.Task, error) {
	var task model.Task
	// gorm.ErrRecordNotFound is intentionally returned unwrapped so callers
	// can use errors.Is(err, gorm.ErrRecordNotFound) directly.
	if err := r.db.WithContext(ctx).Where("idempotency_key = ?", key).First(&task).Error; err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *taskRepository) IncrementRetry(ctx context.Context, id string) error {
	if err := r.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", id).
		UpdateColumn("retry_count", gorm.Expr("retry_count + 1")).Error; err != nil {
		return fmt.Errorf("increment retry %s: %w", id, err)
	}
	return nil
}
