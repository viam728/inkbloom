package repository

import (
	"context"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// FeedbackRow is one joined row of the back-office feedback list.
type FeedbackRow struct {
	ID        int64
	UserID    int64
	Nickname  string
	Category  string
	Content   string
	Contact   string
	Status    string
	CreatedAt time.Time
}

// FeedbackRepository defines data access for user feedback (task #51, M6).
type FeedbackRepository interface {
	Create(ctx context.Context, fb *model.Feedback) error
	// List returns feedback joined with the submitter's nickname, newest
	// first. status filters by exact status; empty returns all.
	List(ctx context.Context, status string, limit int) ([]FeedbackRow, error)
	UpdateStatus(ctx context.Context, id int64, status string) error
}

type feedbackRepository struct {
	db *gorm.DB
}

// NewFeedbackRepository creates a new FeedbackRepository.
func NewFeedbackRepository(db *gorm.DB) FeedbackRepository {
	return &feedbackRepository{db: db}
}

func (r *feedbackRepository) Create(ctx context.Context, fb *model.Feedback) error {
	return r.db.WithContext(ctx).Create(fb).Error
}

func (r *feedbackRepository) List(ctx context.Context, status string, limit int) ([]FeedbackRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `SELECT f.id, f.user_id, COALESCE(u.nickname, '') AS nickname,
			f.category, f.content, COALESCE(f.contact, '') AS contact,
			f.status, f.created_at
			FROM feedbacks f
			LEFT JOIN users u ON u.id = f.user_id`
	var args []interface{}
	if status != "" {
		query += ` WHERE f.status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY f.created_at DESC, f.id DESC LIMIT ?`
	args = append(args, limit)

	var rows []FeedbackRow
	err := r.db.WithContext(ctx).Raw(query, args...).Scan(&rows).Error
	return rows, err
}

func (r *feedbackRepository) UpdateStatus(ctx context.Context, id int64, status string) error {
	res := r.db.WithContext(ctx).Model(&model.Feedback{}).
		Where("id = ?", id).
		Update("status", status)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
