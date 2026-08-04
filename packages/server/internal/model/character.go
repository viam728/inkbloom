package model

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Character represents a character entity within a novel.
type Character struct {
	ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID     int64          `gorm:"not null" json:"novel_id"`
	Name        string         `gorm:"type:varchar(255);not null" json:"name"`
	Role        *string        `gorm:"type:varchar(100)" json:"role,omitempty"`
	Brief       *string        `gorm:"type:text" json:"brief,omitempty"`
	Appearance  *string        `gorm:"type:text" json:"appearance,omitempty"`
	Background  *string        `gorm:"type:text" json:"background,omitempty"`
	Personality *string        `gorm:"type:text" json:"personality,omitempty"`
	Goals       *string        `gorm:"type:text" json:"goals,omitempty"`
	Abilities   *string        `gorm:"type:text" json:"abilities,omitempty"`
	AvatarPath  *string        `gorm:"type:varchar(500);column:avatar_path" json:"avatar_path,omitempty"`
	Metadata    datatypes.JSON `gorm:"type:jsonb;default:'{}'" json:"metadata"`
	CreatedAt   time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`

	// Associations
	Novel *Novel `gorm:"foreignKey:NovelID" json:"novel,omitempty"`
}

// TableName specifies the table name for Character.
func (Character) TableName() string {
	return "characters"
}
