package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// UserRepository defines the interface for user data access.
type UserRepository interface {
	Create(ctx context.Context, user *model.User) error
	GetByID(ctx context.Context, id int64) (*model.User, error)
	GetByPhone(ctx context.Context, phone string) (*model.User, error)
	UpdateLastLogin(ctx context.Context, id int64, at time.Time) error
	// UpdateStatus flips the account status (back-office ban/unban, task #49).
	UpdateStatus(ctx context.Context, id int64, status int16) error
	// UpdateRole sets the account role (admin.phones promotion, task #49).
	UpdateRole(ctx context.Context, id int64, role int16) error
	// EnsureDemoUser creates the demo account (fixed id=1) when absent.
	EnsureDemoUser(ctx context.Context, phone, nickname, passwordHash string) error
}

// userRepository is the GORM implementation of UserRepository.
type userRepository struct {
	db *gorm.DB
}

// NewUserRepository creates a new UserRepository backed by GORM.
func NewUserRepository(db *gorm.DB) UserRepository {
	return &userRepository{db: db}
}

func (r *userRepository) Create(ctx context.Context, user *model.User) error {
	return r.db.WithContext(ctx).Create(user).Error
}

func (r *userRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
	var user model.User
	if err := r.db.WithContext(ctx).First(&user, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

func (r *userRepository) GetByPhone(ctx context.Context, phone string) (*model.User, error) {
	var user model.User
	if err := r.db.WithContext(ctx).Where("phone = ?", phone).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &user, nil
}

func (r *userRepository) UpdateLastLogin(ctx context.Context, id int64, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Update("last_login_at", at).Error
}

func (r *userRepository) UpdateStatus(ctx context.Context, id int64, status int16) error {
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Update("status", status).Error
}

func (r *userRepository) UpdateRole(ctx context.Context, id int64, role int16) error {
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Update("role", role).Error
}

// EnsureDemoUser seeds the demo account with a fixed id=1 (used by task #33
// to backfill legacy data ownership). The argon2id hash carries a random
// salt, so the seed must be computed in Go rather than in SQL.
func (r *userRepository) EnsureDemoUser(ctx context.Context, phone, nickname, passwordHash string) error {
	existing, err := r.GetByPhone(ctx, phone)
	if err != nil {
		return err
	}
	if existing != nil {
		// Sequence may still be misaligned from an earlier seed (task #36);
		// realigning is cheap and idempotent.
		return r.realignUserSequence(ctx)
	}

	now := time.Now()
	demo := &model.User{
		ID:                1,
		Phone:             &phone,
		PasswordHash:      &passwordHash,
		Nickname:          nickname,
		Status:            model.UserStatusActive,
		Role:              model.RoleUser,
		RegisteredChannel: "sms",
		LastLoginAt:       &now,
	}
	if err := r.db.WithContext(ctx).Create(demo).Error; err != nil {
		return err
	}
	return r.realignUserSequence(ctx)
}

// realignUserSequence advances users_id_seq past the maximum existing id so
// the explicitly seeded demo row (id=1) cannot collide with the next real
// registration (task #36: fresh database first-register 500 fix).
// PostgreSQL-only: SQLite's autoincrement tracks the max row id itself.
func (r *userRepository) realignUserSequence(ctx context.Context) error {
	if r.db.Dialector.Name() != "postgres" {
		return nil
	}
	return r.db.WithContext(ctx).Exec(
		`SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true)`,
	).Error
}
