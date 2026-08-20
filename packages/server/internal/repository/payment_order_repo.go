package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// PaymentOrderRepository defines the interface for payment order data access.
type PaymentOrderRepository interface {
	Create(ctx context.Context, order *model.PaymentOrder) error
	GetByOutTradeNo(ctx context.Context, outTradeNo string) (*model.PaymentOrder, error)
	// MarkPaid atomically flips created → paid; returns true only for the
	// caller that actually performed the transition (idempotent callbacks).
	MarkPaid(ctx context.Context, id int64, channelTradeNo string, at time.Time) (bool, error)
	ListByUser(ctx context.Context, userID int64, limit int) ([]model.PaymentOrder, error)
}

// paymentOrderRepository is the GORM implementation.
type paymentOrderRepository struct {
	db *gorm.DB
}

// NewPaymentOrderRepository creates a new PaymentOrderRepository.
func NewPaymentOrderRepository(db *gorm.DB) PaymentOrderRepository {
	return &paymentOrderRepository{db: db}
}

func (r *paymentOrderRepository) Create(ctx context.Context, order *model.PaymentOrder) error {
	return r.db.WithContext(ctx).Create(order).Error
}

func (r *paymentOrderRepository) GetByOutTradeNo(ctx context.Context, outTradeNo string) (*model.PaymentOrder, error) {
	var order model.PaymentOrder
	if err := r.db.WithContext(ctx).Where("out_trade_no = ?", outTradeNo).First(&order).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &order, nil
}

func (r *paymentOrderRepository) MarkPaid(ctx context.Context, id int64, channelTradeNo string, at time.Time) (bool, error) {
	tx := r.db.WithContext(ctx).Model(&model.PaymentOrder{}).
		Where("id = ? AND status = ?", id, model.OrderStatusCreated).
		Updates(map[string]interface{}{
			"status":           model.OrderStatusPaid,
			"channel_trade_no": channelTradeNo,
			"paid_at":          at,
			"fulfilled_at":     at,
		})
	if tx.Error != nil {
		return false, tx.Error
	}
	return tx.RowsAffected == 1, nil
}

func (r *paymentOrderRepository) ListByUser(ctx context.Context, userID int64, limit int) ([]model.PaymentOrder, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	var orders []model.PaymentOrder
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("id DESC").
		Limit(limit).
		Find(&orders).Error
	if err != nil {
		return nil, err
	}
	return orders, nil
}
