package model

import "time"

// NovelBranch is one node of the world-branch tree (世界线): a plot divergence
// point for the whole book. Roots (parent_id NULL) are the mainline; every
// other node hangs off a parent. Most nodes are AI-generated (source='ai');
// a node may link to a real chapter so the tree doubles as a navigator.
type NovelBranch struct {
	ID        int64      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64      `gorm:"not null;index" json:"user_id"`
	NovelID   int64      `gorm:"not null;index" json:"novel_id"`
	ParentID  *int64     `json:"parent_id,omitempty"`
	Title     string     `gorm:"type:varchar(255);not null" json:"title"`
	Summary   string     `gorm:"type:text" json:"summary"`
	Source    string     `gorm:"type:varchar(16);not null;default:'user'" json:"source"` // 'ai' | 'user'
	ChapterID *int64     `json:"chapter_id,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

func (NovelBranch) TableName() string { return "novel_branches" }
