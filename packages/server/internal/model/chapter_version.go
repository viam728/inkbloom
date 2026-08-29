package model

import (
	"time"

	"gorm.io/datatypes"
)

// Version kinds (business plan v3 E1).
const (
	// VersionKindAuto is the session-level snapshot taken automatically while
	// the author writes (throttled + content-hash deduplicated).
	VersionKindAuto = "auto"
	// VersionKindMilestone is an explicit user-authored checkpoint. Never
	// pruned by the retention job.
	VersionKindMilestone = "milestone"
	// VersionKindAIMark is the snapshot written right before an AI rewrite is
	// applied, so the pre-rewrite text stays recoverable.
	VersionKindAIMark = "ai_rewrite"
	// VersionKindRollback is the snapshot of the text that a rollback replaced.
	// It makes the rollback itself reversible.
	VersionKindRollback = "rollback"
	// VersionKindImport holds a conflicting document produced by a .inkbloom
	// import merge, surfaced in the history panel for manual reconciliation.
	VersionKindImport = "import"
)

// ChapterVersion is an immutable snapshot of a chapter's content.
//
// Snapshots are append-only in spirit: the service layer never issues UPDATEs
// against this table, only INSERTs and (for retention) DELETEs limited to the
// VersionKindAuto kind. Milestone / rollback / import versions are kept
// indefinitely so that "undo" is always available for deliberate actions.
type ChapterVersion struct {
	ID        int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64  `gorm:"not null;default:0;index:idx_cver_chapter,priority:1" json:"user_id"`
	ChapterID int64  `gorm:"not null;index:idx_cver_chapter,priority:2" json:"chapter_id"`
	NovelID   int64  `gorm:"not null;index:idx_cver_novel" json:"novel_id"`
	Title     string `gorm:"type:varchar(255)" json:"title"`

	Content     *string        `gorm:"type:text" json:"content,omitempty"`
	ContentJSON datatypes.JSON `gorm:"type:jsonb;column:content_json" json:"content_json,omitempty"`
	WordCount   int            `gorm:"default:0" json:"word_count"`

	// Kind is one of the VersionKind* constants.
	Kind string `gorm:"type:varchar(20);not null;default:'auto';index:idx_cver_chapter,priority:4" json:"kind"`
	// Label is the user-supplied name for milestone versions.
	Label string `gorm:"type:varchar(255)" json:"label,omitempty"`
	// ContentHash is the leading 16 hex chars of sha256(content). Consecutive
	// auto snapshots with an identical hash are skipped.
	ContentHash string `gorm:"type:varchar(16);index:idx_cver_chapter,priority:3" json:"content_hash"`

	CreatedAt time.Time `gorm:"autoCreateTime;index:idx_cver_chapter,priority:5" json:"created_at"`
}

// TableName specifies the table name for ChapterVersion.
func (ChapterVersion) TableName() string {
	return "chapter_versions"
}
