package repository

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// SubscriptionRepository defines the interface for subscription data access.
type SubscriptionRepository interface {
	GetByUserID(ctx context.Context, userID int64) (*model.Subscription, error)
	Create(ctx context.Context, sub *model.Subscription) error
	Update(ctx context.Context, sub *model.Subscription) error
	// ListUserIDsMissingSubscription returns ids of users without a
	// subscription row (backfill target at startup).
	ListUserIDsMissingSubscription(ctx context.Context) ([]int64, error)
}

// subscriptionRepository is the GORM implementation.
type subscriptionRepository struct {
	db *gorm.DB
}

// NewSubscriptionRepository creates a new SubscriptionRepository.
func NewSubscriptionRepository(db *gorm.DB) SubscriptionRepository {
	return &subscriptionRepository{db: db}
}

func (r *subscriptionRepository) GetByUserID(ctx context.Context, userID int64) (*model.Subscription, error) {
	var sub model.Subscription
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&sub).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &sub, nil
}

func (r *subscriptionRepository) Create(ctx context.Context, sub *model.Subscription) error {
	return r.db.WithContext(ctx).Create(sub).Error
}

func (r *subscriptionRepository) Update(ctx context.Context, sub *model.Subscription) error {
	return r.db.WithContext(ctx).Save(sub).Error
}

func (r *subscriptionRepository) ListUserIDsMissingSubscription(ctx context.Context) ([]int64, error) {
	var ids []int64
	err := r.db.WithContext(ctx).
		Raw(`SELECT u.id FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE s.user_id IS NULL`).
		Scan(&ids).Error
	if err != nil {
		return nil, err
	}
	return ids, nil
}
