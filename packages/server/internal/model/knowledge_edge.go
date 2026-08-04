package model

import (
	"time"
)

// KnowledgeEdge represents a relationship between two knowledge nodes.
type KnowledgeEdge struct {
	ID              int64     `gorm:"primaryKey;autoIncrement" json:"id"`
	NovelID         int64     `gorm:"not null;uniqueIndex:idx_knowledge_edges_unique" json:"novel_id"`
	SourceID        int64     `gorm:"not null;uniqueIndex:idx_knowledge_edges_unique" json:"source_id"`
	TargetID        int64     `gorm:"not null;uniqueIndex:idx_knowledge_edges_unique" json:"target_id"`
	RelationType    *string   `gorm:"type:varchar(100);uniqueIndex:idx_knowledge_edges_unique" json:"relation_type,omitempty"`
	Description     *string   `gorm:"type:text" json:"description,omitempty"`
	SourceChapterID *int64    `gorm:"column:source_chapter_id" json:"source_chapter_id,omitempty"`
	CreatedAt       time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for KnowledgeEdge.
func (KnowledgeEdge) TableName() string {
	return "knowledge_edges"
}
