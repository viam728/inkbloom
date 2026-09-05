package model

import (
	"time"

	"gorm.io/datatypes"
)

// Publishing visibility (business plan v3 E4, construction plan A16).
const (
	// VisibilityPublic appears in discovery and is readable by anyone.
	VisibilityPublic = "public"
	// VisibilityUnlisted is readable by anyone holding the exact link, but is
	// absent from discovery. Think "share with a few people".
	VisibilityUnlisted = "unlisted"
	// VisibilityPrivate is not readable by anyone but the author. It is kept
	// as a state rather than deleting the row so a work can be re-published
	// without losing its slug or readership.
	VisibilityPrivate = "private"
)

// ContentFormat records what shape PublishedChapter.Content holds.
//
// Today the editor serialises with TipTap's getHTML(), so bodies are HTML
// fragments — ContentJSON is effectively always empty in production. Naming
// the format explicitly means that if the editor ever switches to storing the
// ProseMirror AST, old and new rows stay distinguishable instead of every
// reader having to guess.
const (
	ContentFormatHTML = "html"
	ContentFormatAST  = "ast"
)

// PublishedWork is the public face of a novel, one-to-one with it.
//
// It deliberately duplicates title/synopsis/cover rather than joining Novel:
// a published work is a separate artefact with its own lifecycle (slug,
// visibility, follow count), and authors routinely keep editing the draft
// after publishing.
type PublishedWork struct {
	ID     int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64  `gorm:"not null;index:idx_pw_user" json:"user_id"`
	NovelID int64 `gorm:"not null;uniqueIndex" json:"novel_id"`
	// Slug is the public handle in /read/:slug. Globally unique so a reader's
	// link cannot be hijacked by another author.
	Slug     string `gorm:"type:varchar(120);not null;uniqueIndex" json:"slug"`
	Title    string `gorm:"type:varchar(255);not null" json:"title"`
	Synopsis string `gorm:"type:text" json:"synopsis"`
	CoverURL string `gorm:"type:varchar(500)" json:"cover_url"`

	Visibility string `gorm:"type:varchar(20);not null;default:'public';index" json:"visibility"`
	// AIInspired is the generative-AI disclosure flag. It is a compliance
	// requirement, not a badge — see service/reader_service for how it is
	// derived and for the known imprecision of the fallback signal.
	AIInspired  bool `gorm:"not null;default:false" json:"ai_inspired"`
	FollowCount int  `gorm:"not null;default:0" json:"follow_count"`

	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for PublishedWork.
func (PublishedWork) TableName() string { return "published_works" }

// PublishedChapter is a point-in-time copy of a chapter's body (服务器保存的
// 第二份文章，备忘录 L61 版本三态：草稿/发布两份在服务器，临时在浏览器).
//
// The body is stored redundantly rather than joined to `chapters` on read,
// and that is the whole point: once a chapter is published, the author
// continuing to edit the draft must NOT change what readers see. A reader
// mid-chapter suddenly seeing different prose is a worse failure than any
// amount of duplicated storage. VersionID additionally points at the
// chapter_versions publish snapshot (发布快照指针) for traceability.
type PublishedChapter struct {
	ID        int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64  `gorm:"not null;index:idx_pc_work,priority:1" json:"user_id"`
	WorkID    int64  `gorm:"not null;index:idx_pc_work,priority:2" json:"work_id"`
	ChapterID int64  `gorm:"not null;index" json:"chapter_id"`
	// VersionID points at the chapter_versions snapshot this publication was
	// taken from, so "which draft state did readers see" stays answerable.
	VersionID *int64 `json:"version_id,omitempty"`

	Title string `gorm:"type:varchar(255);not null" json:"title"`
	// Content is the authoritative body (HTML fragment today).
	Content *string `gorm:"type:text" json:"content,omitempty"`
	// ContentJSON mirrors Chapter.ContentJSON. Currently empty in production
	// for the reason documented on ContentFormat.
	ContentJSON datatypes.JSON `gorm:"type:jsonb;column:content_json" json:"content_json,omitempty"`
	// ContentFormat tells readers how to interpret Content.
	ContentFormat string `gorm:"type:varchar(16);not null;default:'html'" json:"content_format"`

	WordCount int `gorm:"not null;default:0" json:"word_count"`
	Position  int `gorm:"not null;index:idx_pc_work,priority:3" json:"position"`

	// ScheduledAt: nil means visible immediately; otherwise the chapter stays
	// invisible to everyone (author included, via the public API) until this
	// instant passes.
	ScheduledAt *time.Time `gorm:"index" json:"scheduled_at,omitempty"`
	PublishedAt time.Time  `gorm:"autoCreateTime" json:"published_at"`
}

// TableName specifies the table name for PublishedChapter.
func (PublishedChapter) TableName() string { return "published_chapters" }

// ReadingProgress is a reader's position inside a work, enabling
// continue-where-you-left-off across devices.
//
// Position is a 0..1 ratio within the chapter rather than a pixel offset, so
// it survives different screen sizes and font settings.
type ReadingProgress struct {
	ID     int64 `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64 `gorm:"not null;uniqueIndex:idx_rp_user_work,priority:1" json:"user_id"`
	WorkID int64 `gorm:"not null;uniqueIndex:idx_rp_user_work,priority:2" json:"work_id"`
	// ChapterID is the last chapter read; Position is the ratio within it.
	ChapterID int64   `gorm:"not null" json:"chapter_id"`
	Position  float64 `gorm:"not null;default:0" json:"position"`

	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for ReadingProgress.
func (ReadingProgress) TableName() string { return "reading_progress" }

// ReaderFollow is a reader's subscription to a work's updates.
type ReaderFollow struct {
	ID     int64 `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64 `gorm:"not null;uniqueIndex:idx_rf_user_work,priority:1" json:"user_id"`
	WorkID int64 `gorm:"not null;uniqueIndex:idx_rf_user_work,priority:2;index" json:"work_id"`
	// Notify controls whether update notifications are sent. Kept per-row so a
	// reader can follow silently (bookmark-ish) without unfollowing.
	Notify bool `gorm:"not null;default:true" json:"notify"`

	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for ReaderFollow.
func (ReaderFollow) TableName() string { return "reader_follows" }
