package model

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Setting represents a world-building setting entity for a novel.
type Setting struct {
	ID        int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID   int64          `gorm:"not null" json:"novel_id"`
	Title     string         `gorm:"type:varchar(255);not null" json:"title"`
	Category  *string        `gorm:"type:varchar(100)" json:"category,omitempty"`
	Content   *string        `gorm:"type:text" json:"content,omitempty"`
	Metadata  datatypes.JSON `gorm:"type:jsonb;default:'{}'" json:"metadata"`
	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`

	// Associations
	Novel *Novel `gorm:"foreignKey:NovelID" json:"novel,omitempty"`
}

// TableName specifies the table name for Setting.
func (Setting) TableName() string {
	return "settings"
}
