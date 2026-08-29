package model

import "time"

// Foreshadow lifecycle (business plan v3 E2).
const (
	// ForeshadowPlanted is a setup that has not been paid off yet.
	ForeshadowPlanted = "planted"
	// ForeshadowReminded marks a planted thread that has grown stale without
	// being paid off — the system nudges the author about it.
	ForeshadowReminded = "reminded"
	// ForeshadowResolved means the thread was paid off in a specific chapter.
	ForeshadowResolved = "resolved"
	// ForeshadowAbandoned means the author deliberately dropped the thread.
	// Kept (not deleted) so it stops nagging but stays auditable.
	ForeshadowAbandoned = "abandoned"
)

// ForeshadowSource distinguishes author-entered threads from AI-extracted ones.
const (
	ForeshadowSourceManual = "manual"
	ForeshadowSourceAI     = "ai"
)

// Foreshadow is a narrative setup ("伏笔") that should eventually be paid off.
//
// The point of tracking these is not bookkeeping — it powers the proactive
// reminder: a thread planted 20 chapters ago and never resolved is precisely
// the thing a human author loses track of, and the thing AI is good at
// noticing (construction plan A15).
type Foreshadow struct {
	ID          int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID      int64  `gorm:"not null;default:0;index:idx_fs_novel,priority:1" json:"user_id"`
	NovelID     int64  `gorm:"not null;index:idx_fs_novel,priority:2" json:"novel_id"`
	Description string `gorm:"type:text;not null" json:"description"`

	// PlantChapterID is the chapter where the setup appears. Nullable: an
	// author may record an intended thread before writing the scene.
	PlantChapterID *int64 `json:"plant_chapter_id,omitempty"`
	// PlantAnchor is a verbatim sentence fragment from the planting spot,
	// used to jump the editor to that location later.
	PlantAnchor string `gorm:"type:varchar(500)" json:"plant_anchor"`

	// ExpectChapter is the author's intended payoff position (1-based chapter
	// order). Null means "whenever it fits".
	ExpectChapter *int `json:"expect_chapter,omitempty"`

	// Status is one of the Foreshadow* constants.
	Status string `gorm:"type:varchar(20);not null;default:'planted';index:idx_fs_novel,priority:3" json:"status"`
	// ResolveChapterID is the chapter where the thread was paid off.
	ResolveChapterID *int64 `json:"resolve_chapter_id,omitempty"`

	// Source is ForeshadowSourceManual or ForeshadowSourceAI.
	Source string `gorm:"type:varchar(20);not null;default:'manual'" json:"source"`

	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for Foreshadow.
func (Foreshadow) TableName() string {
	return "foreshadows"
}
