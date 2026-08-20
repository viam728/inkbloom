package model

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// MediaContent represents a self-media content entry (independent from novel
// chapters). Tags are stored as a JSONB string array.
type MediaContent struct {
	ID        int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64          `gorm:"not null;default:1;column:user_id" json:"user_id"`
	Title     string         `gorm:"type:varchar(255);not null" json:"title"`
	Platform  string         `gorm:"type:varchar(20);not null" json:"platform"`
	Content   string         `gorm:"type:text;not null;default:''" json:"content"`
	Tags      datatypes.JSON `gorm:"type:jsonb;not null;default:'[]'" json:"tags"`
	Position  int            `gorm:"not null;default:0" json:"position"`
	CreatedAt time.Time      `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"deleted_at,omitempty"`
}

// TableName specifies the table name for MediaContent.
func (MediaContent) TableName() string {
	return "media_contents"
}

// MediaTopic represents a topic idea kanban item. The primary key is a
// client- or server-assigned string id.
type MediaTopic struct {
	ID        string    `gorm:"primaryKey;type:varchar(64)" json:"id"`
	UserID    int64     `gorm:"not null;default:1;column:user_id" json:"user_id"`
	Title     string    `gorm:"type:varchar(255);not null" json:"title"`
	Note      string    `gorm:"type:text;not null;default:''" json:"note"`
	Status    string    `gorm:"type:varchar(20);not null;default:'idea'" json:"status"`
	Position  int       `gorm:"not null;default:0" json:"position"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for MediaTopic.
func (MediaTopic) TableName() string {
	return "media_topics"
}
