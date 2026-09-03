package model

import (
	"time"

	"gorm.io/datatypes"
)

// ChapterTrash 垃圾桶：删除大纲要点时「章节 + 节点 + 正文」一起进桶的自包含
// 快照。恢复时节点插回用户重选的目标幕、章节行复活，绑定关系原样还原。
//
// 正文冗余存储（不只依赖 chapters 的软删行）：桶内记录必须自包含，避免依赖
// chapters 行的存活状态（未来的清理任务/同步导入不应破坏回收能力）。
type ChapterTrash struct {
	ID        int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64  `gorm:"not null;index;column:user_id" json:"user_id"`
	NovelID   int64  `gorm:"not null;index;column:novel_id" json:"novel_id"`
	ChapterID int64  `gorm:"column:chapter_id" json:"chapter_id"` // 0 = 纯规划节点，无正文
	// 节点快照（完整 JSON，含 id/title/summary/status/chapter_id），恢复时原样插回目标幕。
	NodeJSON datatypes.JSON `gorm:"not null;column:node_json" json:"node_json"`
	// 章节元信息 + 正文快照（chapter_id=0 时为空）。
	ChapterTitle string `gorm:"type:varchar(255);column:chapter_title" json:"chapter_title"`
	NodeTitle    string `gorm:"type:varchar(255);column:node_title" json:"node_title"`
	Content      string `gorm:"type:text;column:content" json:"content"`
	WordCount    int    `gorm:"default:0;column:word_count" json:"word_count"`
	// 原所属幕（展示「来自哪一幕」）。
	ActID    string `gorm:"type:varchar(64);column:act_id" json:"act_id"`
	ActTitle string `gorm:"type:varchar(255);column:act_title" json:"act_title"`

	CreatedAt time.Time `gorm:"autoCreateTime;column:created_at" json:"created_at"`
}

func (ChapterTrash) TableName() string { return "chapter_trash" }
