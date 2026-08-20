package model

import (
	"time"
)

// Payment order kinds, channels and statuses (M3, plan doc Appendix A).
const (
	OrderKindSubscription = "subscription"

	OrderChannelSandbox = "sandbox" // dev channel: instant simulated payment
	OrderChannelAlipay  = "alipay"  // TODO: requires merchant qualification
	OrderChannelWechat  = "wechat"  // TODO: requires merchant qualification

	OrderStatusCreated = "created"
	OrderStatusPaid    = "paid"
	OrderStatusClosed  = "closed"
)

// PaymentOrder is a payment order row; out_trade_no is the idempotency key.
type PaymentOrder struct {
	ID     int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64  `gorm:"not null;index" json:"user_id"`
	Kind   string `gorm:"type:varchar(20);not null" json:"kind"`
	// Period is the subscription period this order pays for (month|year);
	// null for non-subscription kinds (token packs, future).
	Period *string `gorm:"type:varchar(10)" json:"period,omitempty"`
	// RefID links the related subscription/token record (nullable).
	RefID          *int64     `gorm:"column:ref_id" json:"ref_id,omitempty"`
	Channel        string     `gorm:"type:varchar(20);not null" json:"channel"`
	AmountCents    int        `gorm:"not null" json:"amount_cents"`
	OutTradeNo     string     `gorm:"type:varchar(64);not null;uniqueIndex" json:"out_trade_no"`
	ChannelTradeNo *string    `gorm:"type:varchar(64);column:channel_trade_no" json:"channel_trade_no,omitempty"`
	Status         string     `gorm:"type:varchar(20);not null;default:'created'" json:"status"`
	PaidAt         *time.Time `json:"paid_at,omitempty"`
	FulfilledAt    *time.Time `json:"fulfilled_at,omitempty"`
	ClosedAt       *time.Time `json:"closed_at,omitempty"`
	CreatedAt      time.Time  `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for PaymentOrder.
func (PaymentOrder) TableName() string {
	return "payment_orders"
}
