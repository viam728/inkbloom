package model

import (
	"time"

	"gorm.io/gorm"
)

// Volume represents a volume entity within a novel.
type Volume struct {
	ID        int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID   int64          `gorm:"not null;index:idx_volumes_novel" json:"novel_id"`
	Title     string         `gorm:"type:varchar(255);not null" json:"title"`
	Position  int            `gorm:"not null;index:idx_volumes_novel" json:"position"`
	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`

	// Associations
	Novel    *Novel    `gorm:"foreignKey:NovelID" json:"novel,omitempty"`
	Chapters []Chapter `gorm:"foreignKey:VolumeID" json:"chapters,omitempty"`
}

// TableName specifies the table name for Volume.
func (Volume) TableName() string {
	return "volumes"
}
