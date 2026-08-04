package model

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Chapter represents a chapter entity within a novel.
type Chapter struct {
	ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID     int64          `gorm:"not null;index:idx_chapters_novel" json:"novel_id"`
	VolumeID    *int64         `gorm:"index" json:"volume_id,omitempty"`
	Title       string         `gorm:"type:varchar(255);not null" json:"title"`
	Content     *string        `gorm:"type:text" json:"content,omitempty"`
	ContentJSON datatypes.JSON `gorm:"type:jsonb;column:content_json" json:"content_json,omitempty"`
	WordCount   int            `gorm:"default:0;column:word_count" json:"word_count"`
	Position    int            `gorm:"not null;index:idx_chapters_novel" json:"position"`
	Summary     *string        `gorm:"type:text" json:"summary,omitempty"`
	Status      string         `gorm:"type:varchar(20);default:'draft'" json:"status"`
	CreatedAt   time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`

	// Associations
	Novel  *Novel  `gorm:"foreignKey:NovelID" json:"novel,omitempty"`
	Volume *Volume `gorm:"foreignKey:VolumeID" json:"volume,omitempty"`
}

// TableName specifies the table name for Chapter.
func (Chapter) TableName() string {
	return "chapters"
}
