package dto

import "time"

// Admin back-office payloads (task #49, M5; plan doc §6.6).

// AdminDashboard is the GET /admin/dashboard payload.
type AdminDashboard struct {
	UsersTotal         int64 `json:"users_total"`
	UsersToday         int64 `json:"users_today"`
	SubsActive         int64 `json:"subs_active"`
	SubsTrialing       int64 `json:"subs_trialing"`
	SubsGrace          int64 `json:"subs_grace"`
	TokenBalanceTotal  int64 `json:"token_balance_total"`
	TokenConsumedToday int64 `json:"token_consumed_today"`
	NovelsTotal        int64 `json:"novels_total"`
	AICallsToday       int64 `json:"ai_calls_today"`
}

// AdminSubscriptionSummary is the subscription slice of an admin user row.
type AdminSubscriptionSummary struct {
	Status    string     `json:"status"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// AdminUserItem is one row of the GET /admin/users list.
type AdminUserItem struct {
	ID                int64                     `json:"id"`
	Phone             string                    `json:"phone"`
	Nickname          string                    `json:"nickname"`
	Status            int16                     `json:"status"`
	Role              int16                     `json:"role"`
	RegisteredChannel string                    `json:"registered_channel"`
	CreatedAt         time.Time                 `json:"created_at"`
	LastLoginAt       *time.Time                `json:"last_login_at,omitempty"`
	Subscription      *AdminSubscriptionSummary `json:"subscription,omitempty"`
	TokenBalance      int64                     `json:"token_balance"`
}

// AdminUserList is the GET /admin/users payload.
type AdminUserList struct {
	Total int64           `json:"total"`
	Items []AdminUserItem `json:"items"`
}

// AdminSetStatusRequest is POST /admin/users/:id/status.
type AdminSetStatusRequest struct {
	// Status 0 = active, 1 = disabled (mirrors users.status).
	Status int16 `json:"status" binding:"oneof=0 1"`
}

// AdminExtendRequest is POST /admin/subscriptions/:user_id/extend.
type AdminExtendRequest struct {
	Days int `json:"days" binding:"required,min=1,max=3650"`
}

// AdminTokenGrantRequest is POST /admin/token/grant.
type AdminTokenGrantRequest struct {
	UserID int64  `json:"user_id" binding:"required,min=1"`
	Amount int64  `json:"amount" binding:"required,min=1"`
	Note   string `json:"note"`
}

// AdminOrderItem is one merged row of GET /admin/orders.
type AdminOrderItem struct {
	Kind        string     `json:"kind"` // subscription | token
	ID          int64      `json:"id"`
	UserID      int64      `json:"user_id"`
	AmountCents int        `json:"amount_cents"`
	Tokens      int64      `json:"tokens,omitempty"` // token orders only
	Status      string     `json:"status"`
	Channel     string     `json:"channel"`
	OutTradeNo  string     `json:"out_trade_no"`
	CreatedAt   time.Time  `json:"created_at"`
	PaidAt      *time.Time `json:"paid_at,omitempty"`
}
