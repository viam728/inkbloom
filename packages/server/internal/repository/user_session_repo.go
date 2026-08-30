package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// UserSessionRepository persists authentication sessions (plan A22).
//
// Sessions are scoped by user for every mutation; the JTI is globally unique
// so refresh rotation can consume a token by jti without ambiguity.
type UserSessionRepository interface {
	// Create inserts a new session row.
	Create(ctx context.Context, s *model.UserSession) error
	// Consume atomically removes the session carrying jti and returns it.
	// found=false means the token was already rotated, logged out or unknown.
	// The row is deleted in a single statement so two concurrent refreshes
	// cannot both win (one gets RowsAffected=0).
	Consume(ctx context.Context, jti string) (*model.UserSession, bool, error)
	// CountActive counts non-expired sessions for the user.
	CountActive(ctx context.Context, userID int64) (int64, error)
	// DeleteOldest removes the least-recently-active session (device limit).
	DeleteOldest(ctx context.Context, userID int64) error
	// ListByUser returns the user's sessions, most recent first.
	ListByUser(ctx context.Context, userID int64) ([]model.UserSession, error)
	// DeleteByID removes one session owned by the user.
	DeleteByID(ctx context.Context, userID, id int64) error
	// DeleteByUser removes every session for the user (logout-all).
	DeleteByUser(ctx context.Context, userID int64) error
	// DeleteExpired purges expired sessions; returns the number removed.
	DeleteExpired(ctx context.Context, now time.Time) (int64, error)
}

type userSessionRepository struct {
	db *gorm.DB
}

// NewUserSessionRepository creates a new UserSessionRepository.
func NewUserSessionRepository(db *gorm.DB) UserSessionRepository {
	return &userSessionRepository{db: db}
}

func (r *userSessionRepository) Create(ctx context.Context, s *model.UserSession) error {
	return r.db.WithContext(ctx).Create(s).Error
}

func (r *userSessionRepository) Consume(ctx context.Context, jti string) (*model.UserSession, bool, error) {
	var s model.UserSession
	err := r.db.WithContext(ctx).Where("jti = ?", jti).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	// Atomic delete: only one concurrent caller observes RowsAffected == 1.
	res := r.db.WithContext(ctx).
		Where("id = ? AND jti = ?", s.ID, s.JTI).
		Delete(&model.UserSession{})
	if res.Error != nil {
		return nil, false, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, false, nil
	}
	return &s, true, nil
}

func (r *userSessionRepository) CountActive(ctx context.Context, userID int64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.UserSession{}).
		Where("user_id = ? AND expires_at > ?", userID, time.Now()).
		Count(&n).Error
	return n, err
}

func (r *userSessionRepository) DeleteOldest(ctx context.Context, userID int64) error {
	var s model.UserSession
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("last_active_at ASC").
		First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return r.db.WithContext(ctx).Delete(&model.UserSession{}, s.ID).Error
}

func (r *userSessionRepository) ListByUser(ctx context.Context, userID int64) ([]model.UserSession, error) {
	var list []model.UserSession
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("last_active_at DESC").
		Find(&list).Error
	return list, err
}

func (r *userSessionRepository) DeleteByID(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, userID).
		Delete(&model.UserSession{}).Error
}

func (r *userSessionRepository) DeleteByUser(ctx context.Context, userID int64) error {
	return r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Delete(&model.UserSession{}).Error
}

func (r *userSessionRepository) DeleteExpired(ctx context.Context, now time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Where("expires_at <= ?", now).
		Delete(&model.UserSession{})
	return res.RowsAffected, res.Error
}
