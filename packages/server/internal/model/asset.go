package model

import (
	"time"

	"gorm.io/datatypes"
)

// Asset scope values (task #57: image gallery).
const (
	AssetScopeNovel = "novel"
	AssetScopeMedia = "media"
	AssetScopeMemo  = "memo"
)

// Asset source values (task #57: image gallery).
const (
	AssetSourceAI     = "ai"
	AssetSourceUpload = "upload"
)

// Asset represents a generated image or other media asset.
type Asset struct {
	ID            int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID        int64          `gorm:"not null;default:1;column:user_id;uniqueIndex:idx_assets_user_hash,priority:1" json:"user_id"`
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
	// ContentHash is the sha256 of the stored bytes (task #57). NULL on
	// legacy rows; the unique index tolerates multiple NULLs in both
	// PostgreSQL and SQLite.
	ContentHash string `gorm:"type:varchar(64);index;column:content_hash;uniqueIndex:idx_assets_user_hash,priority:2" json:"content_hash,omitempty"`
	// DisplayName is the gallery display name (timestamp + extension).
	DisplayName string `gorm:"type:varchar(200);column:display_name" json:"display_name,omitempty"`
	// Scope groups gallery images: novel | media | memo.
	Scope string `gorm:"type:varchar(20);not null;default:'novel'" json:"scope"`
	// Source records provenance: ai | upload.
	Source    string    `gorm:"type:varchar(20);not null;default:'ai'" json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// TableName returns the database table name for Asset.
func (Asset) TableName() string { return "assets" }
