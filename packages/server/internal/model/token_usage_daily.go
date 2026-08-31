package model

import "time"

// TokenUsageDaily is a per-user, per-day consumption aggregate (plan A30, T3).
//
// It denormalises token_ledger debits into day buckets so the user usage
// panel and the admin dashboard can read a trend without scanning the
// append-only ledger. Rows are upserted (accumulated) on every deduction.
type TokenUsageDaily struct {
	ID     int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64  `gorm:"not null;uniqueIndex:idx_tud_user_date,priority:1" json:"user_id"`
	// Date is the local day key (YYYY-MM-DD) in TokenStatsTimezone.
	Date string `gorm:"type:varchar(10);not null;uniqueIndex:idx_tud_user_date,priority:2" json:"date"`

	// TextUnits is the sum of text-AI deductions (ai_call and any other
	// non-image consume reason).
	TextUnits int64 `gorm:"not null;default:0" json:"text_units"`
	// ImageCount is the number of image generations deducted.
	ImageCount int64 `gorm:"not null;default:0" json:"image_count"`
	// ImageUnits is the sum of image-generation deductions.
	ImageUnits int64 `gorm:"not null;default:0" json:"image_units"`

	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for TokenUsageDaily.
func (TokenUsageDaily) TableName() string { return "token_usage_daily" }
