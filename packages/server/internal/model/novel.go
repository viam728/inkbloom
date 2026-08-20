package model

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Novel represents a novel entity.
type Novel struct {
	ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID      int64          `gorm:"not null;default:1;column:user_id" json:"user_id"`
	Title       string         `gorm:"type:varchar(255);not null" json:"title"`
	Genre       *string        `gorm:"type:varchar(100)" json:"genre,omitempty"`
	Description *string        `gorm:"type:text" json:"description,omitempty"`
	CoverImage  *string        `gorm:"type:varchar(500);column:cover_image" json:"cover_image,omitempty"`
	WordCount   int            `gorm:"default:0;column:word_count" json:"word_count"`
	Status      string         `gorm:"type:varchar(20);default:'draft'" json:"status"`
	Metadata    datatypes.JSON `gorm:"type:jsonb;default:'{}'" json:"metadata"`
	CreatedAt   time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`

	// Associations
	Volumes    []Volume    `gorm:"foreignKey:NovelID" json:"volumes,omitempty"`
	Chapters   []Chapter   `gorm:"foreignKey:NovelID" json:"chapters,omitempty"`
	Settings   []Setting   `gorm:"foreignKey:NovelID" json:"settings,omitempty"`
	Characters []Character `gorm:"foreignKey:NovelID" json:"characters,omitempty"`
}

// TableName specifies the table name for Novel.
func (Novel) TableName() string {
	return "novels"
}
