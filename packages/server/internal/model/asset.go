package model

import (
	"time"

	"gorm.io/datatypes"
)

// Asset represents a generated image or other media asset.
type Asset struct {
	ID            int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID       *int64         `json:"novel_id"`
	ChapterID     *int64         `json:"chapter_id"`
	TaskID        string         `gorm:"type:varchar(36)" json:"task_id"`
	FilePath      string         `gorm:"type:varchar(500);not null" json:"file_path"`
	ThumbnailPath string         `gorm:"type:varchar(500)" json:"thumbnail_path"`
	Prompt        string         `gorm:"type:text" json:"prompt"`
	Provider      string         `gorm:"type:varchar(50)" json:"provider"`
	Width         int32          `json:"width"`
	Height        int32          `json:"height"`
	FileSize      int32          `json:"file_size"`
	Confirmed     bool           `gorm:"default:false" json:"confirmed"`
	Metadata      datatypes.JSON `gorm:"type:jsonb;default:'{}'" json:"metadata"`
	CreatedAt     time.Time      `json:"created_at"`
}

// TableName returns the database table name for Asset.
func (Asset) TableName() string { return "assets" }
