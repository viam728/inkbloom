package model

import (
	"time"

	"gorm.io/datatypes"
)

// NovelOutline stores the structured outline (acts) of a novel.
// Mapped to the novel_outline table (1:1 with novels, novel_id is the PK).
// The acts payload is opaque JSONB owned by the frontend contract.
type NovelOutline struct {
	NovelID   int64          `gorm:"primaryKey" json:"novel_id"`
	UserID    int64          `gorm:"not null;default:1;column:user_id" json:"user_id"`
	Acts      datatypes.JSON `gorm:"type:jsonb;not null;default:'[]'" json:"acts"`
	Version   int            `gorm:"not null;default:0" json:"version"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// TableName specifies the table name for NovelOutline.
func (NovelOutline) TableName() string {
	return "novel_outline"
}
