package model

import (
	"time"

	"gorm.io/datatypes"
)

// MediaMemory stores the per-user memory items of the self-media workspace.
// Mapped to the media_memory table, keyed by user_id (one row per user;
// migration 010 converted the former id=1 singleton into a user-keyed table).
// The items payload is opaque JSONB owned by the frontend contract (item ids
// are frontend-generated UUID strings). Version keeps the PUT optimistic-lock
// semantics unchanged.
type MediaMemory struct {
	UserID    int64          `gorm:"primaryKey;uniqueIndex;column:user_id" json:"user_id"`
	Items     datatypes.JSON `gorm:"type:jsonb;not null;default:'[]'" json:"items"`
	Version   int            `gorm:"not null;default:1" json:"version"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// TableName specifies the table name for MediaMemory.
func (MediaMemory) TableName() string {
	return "media_memory"
}
