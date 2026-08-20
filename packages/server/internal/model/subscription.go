package model

import (
	"time"
)

// Subscription status values. The stored status is the last persisted one;
// the *effective* status is derived from timestamps at read time (time-driven
// state machine, product-commercialization-plan §3):
//
//	now <  expires_at          → trialing/active (stored status)
//	now >= expires_at + 180d   → dormant (read-only, pending cleanup)
//	now >= expires_at          → grace   (read-only, 30d window)
const (
	SubscriptionTrialing = "trialing"
	SubscriptionActive   = "active"
	SubscriptionGrace    = "grace"
	SubscriptionDormant  = "dormant"
)

// Subscription duration parameters (plan doc §3.1).
const (
	TrialDays   = 14  // free trial after registration, no card required
	GraceDays   = 30  // read-only grace window after expiry
	DormantDays = 180 // dormant (deletion-mark) after expiry
)

// Subscription is the per-user subscription row (1:1 with users).
type Subscription struct {
	UserID    int64     `gorm:"primaryKey;column:user_id" json:"user_id"`
	Plan      string    `gorm:"type:varchar(20);not null;default:'base'" json:"plan"`
	Status    string    `gorm:"type:varchar(20);not null;default:'trialing'" json:"status"`
	StartedAt time.Time `gorm:"not null" json:"started_at"`
	ExpiresAt time.Time `gorm:"not null" json:"expires_at"`
	// GraceUntil = ExpiresAt + GraceDays; informational, state is derived.
	GraceUntil         *time.Time `gorm:"column:grace_until" json:"grace_until,omitempty"`
	LastPaymentOrderID *int64     `gorm:"column:last_payment_order_id" json:"last_payment_order_id,omitempty"`
	UpdatedAt          time.Time  `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for Subscription.
func (Subscription) TableName() string {
	return "subscriptions"
}
