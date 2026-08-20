package model

import "time"

// Token billing models (task #43, M4; product-commercialization-plan §5).
// The deduction unit price is input x1 + output x2; image generation costs
// a flat 60000 units per image. AI entitlements depend ONLY on the token
// balance — never on the subscription state (the two systems are decoupled).

// Ledger directions and entry reasons (token_ledger append-only rows).
const (
	LedgerDirectionCredit = 1
	LedgerDirectionDebit  = -1

	LedgerReasonRecharge = "recharge"
	LedgerReasonGift     = "gift"
	LedgerReasonAICall   = "ai_call"
	LedgerReasonImageGen = "image_gen"
	LedgerReasonRefund   = "refund"
	LedgerReasonAdmin    = "admin"
	// LedgerReasonAdminGrant marks back-office token grants (task #49, M5).
	LedgerReasonAdminGrant = "admin_grant"

	LedgerRefTypeOrder = "order"
	LedgerRefTypeTask  = "task"
)

// Token order states / channels / packs (token_orders).
const (
	TokenOrderStatusCreated = "created"
	TokenOrderStatusPaid    = "paid"
	TokenOrderStatusClosed  = "closed"

	TokenOrderChannelSandbox = "sandbox"

	TokenPackStandard = "standard"
	TokenPackPro      = "pro"
)

// Billing parameters (plan doc §5.2). Exported so handler/service share
// one definition; LowBalanceThreshold stays a plain constant (configurable
// later without a contract change).
const (
	// TrialGiftUnits is the free experience pack granted at registration.
	TrialGiftUnits int64 = 500000
	// GiftValidDays is the experience pack validity window.
	GiftValidDays = 90
	// LowBalanceThreshold marks accounts below it as low_balance.
	LowBalanceThreshold int64 = 50000
	// ImageGenUnits is the flat deduction per generated image.
	ImageGenUnits int64 = 60000
	// FallbackConsumeUnits is the conservative deduction applied when the
	// upstream response carries no usage block.
	FallbackConsumeUnits int64 = 2000
	// UnitPriceInput / UnitPriceOutput define the deduction unit.
	UnitPriceInput  int64 = 1
	UnitPriceOutput int64 = 2
)

// TokenAccount is the per-user token balance row (token_accounts). Balance
// is denominated in deduction units; gift_balance is deducted first and
// becomes unusable after GiftExpiresAt. Version guards concurrent
// deductions via optimistic locking.
type TokenAccount struct {
	UserID         int64      `gorm:"primaryKey" json:"user_id"`
	Balance        int64      `gorm:"not null;default:0" json:"balance"`
	GiftBalance    int64      `gorm:"not null;default:0" json:"gift_balance"`
	GiftExpiresAt  *time.Time `json:"gift_expires_at"`
	TotalRecharged int64      `gorm:"not null;default:0" json:"total_recharged"`
	TotalConsumed  int64      `gorm:"not null;default:0" json:"total_consumed"`
	Version        int        `gorm:"not null;default:0" json:"version"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// TableName specifies the table name for TokenAccount.
func (TokenAccount) TableName() string { return "token_accounts" }

// UsableGift returns the gift balance usable at time now (0 once expired).
func (a *TokenAccount) UsableGift(now time.Time) int64 {
	if a.GiftExpiresAt != nil && !now.Before(*a.GiftExpiresAt) {
		return 0
	}
	return a.GiftBalance
}

// UsableBalance returns the combined spendable balance at time now.
func (a *TokenAccount) UsableBalance(now time.Time) int64 {
	return a.Balance + a.UsableGift(now)
}

// TokenLedger is one append-only token statement row (token_ledger).
type TokenLedger struct {
	ID               int64     `gorm:"primaryKey" json:"id"`
	UserID           int64     `gorm:"not null;index:idx_token_ledger_user_time,priority:1" json:"user_id"`
	Direction        int       `gorm:"not null" json:"direction"` // 1 credit | -1 debit
	Amount           int64     `gorm:"not null" json:"amount"`
	BalanceAfter     int64     `gorm:"not null" json:"balance_after"`
	Reason           string    `gorm:"size:32;not null" json:"reason"`
	RefType          *string   `gorm:"size:32" json:"ref_type"`
	RefID            *string   `gorm:"size:64" json:"ref_id"`
	Model            *string   `gorm:"size:64" json:"model"`
	PromptTokens     *int      `json:"prompt_tokens"`
	CompletionTokens *int      `json:"completion_tokens"`
	Endpoint         *string   `gorm:"size:100" json:"endpoint"`
	CreatedAt        time.Time `gorm:"index:idx_token_ledger_user_time,priority:2,sort:desc" json:"created_at"`
}

// TableName specifies the table name for TokenLedger.
func (TokenLedger) TableName() string { return "token_ledger" }

// TokenOrder is a token pack recharge order (token_orders). out_trade_no is
// the idempotency key; sandbox orders are paid within the same request.
type TokenOrder struct {
	ID          int64      `gorm:"primaryKey" json:"id"`
	UserID      int64      `gorm:"not null;index" json:"user_id"`
	Pack        string     `gorm:"size:20;not null" json:"pack"`
	Tokens      int64      `gorm:"not null" json:"tokens"`
	AmountCents int        `gorm:"not null" json:"amount_cents"`
	Channel     string     `gorm:"size:20;not null" json:"channel"`
	OutTradeNo  string     `gorm:"size:64;not null;uniqueIndex" json:"out_trade_no"`
	Status      string     `gorm:"size:20;not null;default:created" json:"status"`
	PaidAt      *time.Time `json:"paid_at"`
	CreatedAt   time.Time  `json:"created_at"`
}

// TableName specifies the table name for TokenOrder.
func (TokenOrder) TableName() string { return "token_orders" }
