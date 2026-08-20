package model

import (
	"time"

	"gorm.io/datatypes"
)

// Task represents an asynchronous AIGC task.
type Task struct {
	ID             string         `gorm:"primaryKey;type:varchar(36)" json:"id"`
	UserID         int64          `gorm:"not null;default:1;column:user_id" json:"user_id"`
	Type           string         `gorm:"type:varchar(50);not null" json:"type"`
	Status         string         `gorm:"type:varchar(20);default:pending" json:"status"` // pending/running/success/failed/dead_letter
	Priority       int16          `gorm:"default:1" json:"priority"`
	Payload        datatypes.JSON `gorm:"type:jsonb" json:"payload"`
	Result         datatypes.JSON `gorm:"type:jsonb" json:"result"`
	Progress       int16          `gorm:"default:0" json:"progress"`
	ErrorMsg       string         `gorm:"type:text" json:"error_msg"`
	RetryCount     int16          `gorm:"default:0" json:"retry_count"`
	MaxRetries     int16          `gorm:"default:3" json:"max_retries"`
	IdempotencyKey string         `gorm:"uniqueIndex;type:varchar(64)" json:"idempotency_key"`
	NovelID        *int64         `json:"novel_id"`
	ChapterID      *int64         `json:"chapter_id"`
	CreatedAt      time.Time      `json:"created_at"`
	StartedAt      *time.Time     `json:"started_at"`
	CompletedAt    *time.Time     `json:"completed_at"`
}

// TableName returns the database table name for Task.
func (Task) TableName() string { return "tasks" }

// Outbox implements the transactional outbox pattern for reliable event publishing.
type Outbox struct {
	ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	EventType   string         `gorm:"type:varchar(100);not null" json:"event_type"`
	Payload     datatypes.JSON `gorm:"type:jsonb;not null" json:"payload"`
	Status      string         `gorm:"type:varchar(20);default:pending" json:"status"` // pending/published/failed
	CreatedAt   time.Time      `json:"created_at"`
	PublishedAt *time.Time     `json:"published_at"`
}

// TableName returns the database table name for Outbox.
func (Outbox) TableName() string { return "outbox" }
