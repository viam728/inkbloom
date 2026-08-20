package dto

import "time"

// Token balance / ledger / stats / order DTOs (task #43, M4). Field names
// are a FROZEN contract — the frontend builds against them in parallel.

// TokenBalanceResponse is the frozen contract shape of GET /api/v1/token/balance.
type TokenBalanceResponse struct {
	Balance        int64      `json:"balance"`
	GiftBalance    int64      `json:"gift_balance"`
	GiftExpiresAt  *time.Time `json:"gift_expires_at"`
	TotalRecharged int64      `json:"total_recharged"`
	TotalConsumed  int64      `json:"total_consumed"`
	LowBalance     bool       `json:"low_balance"`
}

// TokenLedgerItem is one row of the token statement.
type TokenLedgerItem struct {
	ID               int64     `json:"id"`
	Direction        int       `json:"direction"` // 1 credit | -1 debit
	Amount           int64     `json:"amount"`
	BalanceAfter     int64     `json:"balance_after"`
	Reason           string    `json:"reason"`
	RefType          *string   `json:"ref_type"`
	Model            *string   `json:"model"`
	PromptTokens     *int      `json:"prompt_tokens"`
	CompletionTokens *int      `json:"completion_tokens"`
	Endpoint         *string   `json:"endpoint"`
	CreatedAt        time.Time `json:"created_at"`
}

// TokenLedgerResponse is the frozen contract shape of GET /api/v1/token/ledger.
type TokenLedgerResponse struct {
	Items []TokenLedgerItem `json:"items"`
}

// TokenStatsPoint is one bucket of the consumption series.
type TokenStatsPoint struct {
	Bucket   string `json:"bucket"` // YYYY-MM-DD
	Consumed int64  `json:"consumed"`
}

// TokenStatsResponse is the frozen contract shape of GET /api/v1/token/stats.
type TokenStatsResponse struct {
	Total  int64             `json:"total"`
	Series []TokenStatsPoint `json:"series"`
}

// CreateTokenOrderRequest is the payload of POST /api/v1/token/orders.
type CreateTokenOrderRequest struct {
	Pack    string `json:"pack" binding:"required"`    // standard | pro
	Channel string `json:"channel" binding:"required"` // sandbox
}

// CreateTokenOrderResponse is the frozen contract shape of order creation.
type CreateTokenOrderResponse struct {
	OrderID     int64  `json:"order_id"`
	OutTradeNo  string `json:"out_trade_no"`
	AmountCents int    `json:"amount_cents"`
	Pack        string `json:"pack"`
	Tokens      int64  `json:"tokens"`
	Status      string `json:"status"` // paid (sandbox pays instantly)
}

// TokenOrderDTO is one entry of the token order list contract.
type TokenOrderDTO struct {
	OrderID     int64     `json:"order_id"`
	Pack        string    `json:"pack"`
	Tokens      int64     `json:"tokens"`
	AmountCents int       `json:"amount_cents"`
	Channel     string    `json:"channel"`
	Status      string    `json:"status"` // created | paid | closed
	CreatedAt   time.Time `json:"created_at"`
}

// TokenOrderListResponse is the frozen contract shape of GET /api/v1/token/orders.
type TokenOrderListResponse struct {
	Orders []TokenOrderDTO `json:"orders"`
}
