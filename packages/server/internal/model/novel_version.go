package model

import (
	"time"

	"gorm.io/datatypes"
)

// NovelVersion is an immutable point-in-time bundle of a WHOLE novel: every
// chapter plus the outline and the memory document (Agent safety work Q3,
// business plan v3).
//
// Where ChapterVersion protects a single chapter against an Agent overwrite,
// NovelVersion protects the book as a unit: restoring one row brings chapters,
// outline and memory back to the same moment, which is what an author actually
// means by "before the Agent touched it".
//
// Snapshots are append-only in spirit: the service layer only ever inserts
// (plus explicit deletes by the author). A restore never mutates an existing
// row either — it writes a fresh rollback checkpoint first, so a restore is
// itself reversible.
//
// Snapshot is datatypes.JSON: jsonb on PostgreSQL (cloud) and text on SQLite
// (local desktop). No engine-specific SQL is issued anywhere (contract C11).
type NovelVersion struct {
	ID      int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID  int64  `gorm:"not null;default:0;index:idx_nver_novel,priority:1" json:"user_id"`
	NovelID int64  `gorm:"not null;index:idx_nver_novel,priority:2" json:"novel_id"`
	Title   string `gorm:"type:varchar(255)" json:"title"`

	// Snapshot is the whole-novel bundle; see dto.NovelSnapshot for its shape.
	Snapshot datatypes.JSON `gorm:"type:jsonb;column:snapshot" json:"snapshot,omitempty"`

	// Kind is one of the VersionKind* constants defined in chapter_version.go
	// (milestone for an explicit author checkpoint, rollback for the
	// automatic pre-restore snapshot). Reused verbatim — do not redefine.
	Kind string `gorm:"type:varchar(20);not null;default:'milestone';index:idx_nver_novel,priority:3" json:"kind"`
	// Label is the user-supplied name for milestone versions.
	Label string `gorm:"type:varchar(255)" json:"label,omitempty"`
	// ContentHash is the leading 16 hex chars of sha256(snapshot bytes).
	// Unlike the chapter auto-snapshot it never gates a write: a milestone
	// is always stored when the author asks for one.
	ContentHash string `gorm:"type:varchar(16)" json:"content_hash"`

	// ChapterCount / WordCount are denormalized so the history panel can
	// render the list without deserializing the bundle.
	ChapterCount int `gorm:"default:0" json:"chapter_count"`
	WordCount    int `gorm:"default:0" json:"word_count"`

	CreatedAt time.Time `gorm:"autoCreateTime;index:idx_nver_novel,priority:4" json:"created_at"`
}

// TableName specifies the table name for NovelVersion.
func (NovelVersion) TableName() string {
	return "novel_versions"
}
