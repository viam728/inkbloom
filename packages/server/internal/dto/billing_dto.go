package dto

import "time"

// SubscriptionResponse is the frozen contract shape of GET /api/v1/subscription.
type SubscriptionResponse struct {
	Plan       string     `json:"plan"`
	Status     string     `json:"status"` // trialing | active | grace | dormant
	StartedAt  time.Time  `json:"started_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	GraceUntil *time.Time `json:"grace_until"`
	DaysLeft   int        `json:"days_left"`
	ReadOnly   bool       `json:"read_only"`
}

// CreateOrderRequest is the payload of POST /api/v1/subscription/orders.
type CreateOrderRequest struct {
	Period  string `json:"period" binding:"required"`  // month | year
	Channel string `json:"channel" binding:"required"` // sandbox | alipay | wechat
}

// CreateOrderResponse is the frozen contract shape of order creation.
type CreateOrderResponse struct {
	OrderID     int64  `json:"order_id"`
	OutTradeNo  string `json:"out_trade_no"`
	AmountCents int    `json:"amount_cents"`
	Channel     string `json:"channel"`
	Status      string `json:"status"` // created | paid
}

// NotifyRequest is the payload of POST /api/v1/payment/notify/:channel.
type NotifyRequest struct {
	OutTradeNo string `json:"out_trade_no" binding:"required"`
}

// OrderDTO is one entry of the order list contract.
type OrderDTO struct {
	OrderID     int64      `json:"order_id"`
	Kind        string     `json:"kind"`
	Period      string     `json:"period,omitempty"`
	AmountCents int        `json:"amount_cents"`
	Channel     string     `json:"channel"`
	Status      string     `json:"status"` // created | paid | closed
	PaidAt      *time.Time `json:"paid_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// OrderListResponse is the frozen contract shape of GET /api/v1/payment/orders.
type OrderListResponse struct {
	Orders []OrderDTO `json:"orders"`
}
