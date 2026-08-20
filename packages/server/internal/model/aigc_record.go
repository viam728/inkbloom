package model

import "time"

// AIGCRecord captures one AIGC image generation event (task #64).
//
// Every generation writes exactly one record — including dedupe hits that
// reuse an existing asset — so the global AIGC history stays complete even
// when the underlying bytes are shared across generations.
type AIGCRecord struct {
	ID        int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64     `gorm:"not null;index:idx_aigc_records_user_created,priority:1" json:"user_id"`
	TaskID    string    `gorm:"type:varchar(36);not null" json:"task_id"`
	Prompt    string    `gorm:"type:text;not null" json:"prompt"`
	Provider  string    `gorm:"type:varchar(50);not null" json:"provider"`
	AssetID   int64     `gorm:"not null" json:"asset_id"`
	NovelID   *int64    `json:"novel_id"`
	Scope     string    `gorm:"type:varchar(20);not null;default:'novel'" json:"scope"`
	Width     int32     `gorm:"not null;default:0" json:"width"`
	Height    int32     `gorm:"not null;default:0" json:"height"`
	CreatedAt time.Time `gorm:"index:idx_aigc_records_user_created,priority:2" json:"created_at"`
}

// TableName returns the database table name for AIGCRecord.
func (AIGCRecord) TableName() string { return "aigc_records" }
