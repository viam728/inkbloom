package model

import (
	"time"
)

// Feedback category values (task #51, M6).
const (
	FeedbackCategoryBug     = "bug"
	FeedbackCategoryFeature = "feature"
	FeedbackCategoryOther   = "other"
)

// Feedback status values (task #51, M6).
const (
	FeedbackStatusOpen     = "open"
	FeedbackStatusResolved = "resolved"
)

// Feedback represents a user feedback entry (migration 016).
type Feedback struct {
	ID        int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64     `gorm:"not null;index" json:"user_id"`
	Category  string    `gorm:"type:varchar(20);not null" json:"category"`
	Content   string    `gorm:"type:text;not null" json:"content"`
	Contact   *string   `gorm:"type:varchar(128)" json:"contact,omitempty"`
	Status    string    `gorm:"type:varchar(20);not null;default:'open'" json:"status"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for Feedback.
func (Feedback) TableName() string {
	return "feedbacks"
}
