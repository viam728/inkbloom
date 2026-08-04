package model

import (
	"time"

	"gorm.io/datatypes"
)

// NovelMemory stores the curated memory items of a novel.
// Mapped to the novel_memory table (1:1 with novels, novel_id is the PK).
// The items payload is opaque JSONB owned by the frontend contract
// (item ids are frontend-generated UUID strings).
type NovelMemory struct {
	NovelID   int64          `gorm:"primaryKey" json:"novel_id"`
	Items     datatypes.JSON `gorm:"type:jsonb;not null;default:'[]'" json:"items"`
	Version   int            `gorm:"not null;default:0" json:"version"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// TableName specifies the table name for NovelMemory.
func (NovelMemory) TableName() string {
	return "novel_memory"
}
