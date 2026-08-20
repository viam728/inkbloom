package model

import (
	"time"

	"gorm.io/datatypes"
)

// KnowledgeNode represents an entity node in the knowledge graph.
type KnowledgeNode struct {
	ID              int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID          int64          `gorm:"not null;default:1;column:user_id" json:"user_id"`
	NovelID         int64          `gorm:"not null;index:idx_knowledge_nodes_novel;uniqueIndex:idx_knowledge_nodes_unique" json:"novel_id"`
	Name            string         `gorm:"type:varchar(255);not null;uniqueIndex:idx_knowledge_nodes_unique" json:"name"`
	Type            *string        `gorm:"type:varchar(50);index:idx_knowledge_nodes_novel;uniqueIndex:idx_knowledge_nodes_unique" json:"type,omitempty"`
	Properties      datatypes.JSON `gorm:"type:jsonb;default:'{}'" json:"properties"`
	SourceChapterID *int64         `gorm:"column:source_chapter_id" json:"source_chapter_id,omitempty"`
	CreatedAt       time.Time      `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for KnowledgeNode.
func (KnowledgeNode) TableName() string {
	return "knowledge_nodes"
}
