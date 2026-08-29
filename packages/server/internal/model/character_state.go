package model

import (
	"time"

	"gorm.io/datatypes"
)

// CharacterState is a character's knowledge snapshot at a given chapter
// (business plan v3 E2, construction plan A10/A14).
//
// It exists to answer one question the consistency checker needs: "did this
// character know fact X at this point in the story?" Without a per-chapter
// snapshot, an AI review can only compare against the character sheet, which
// reflects the character's state at the END of the book, not mid-story — and
// that produces false "inconsistency" reports for correct writing.
//
// One row per (novel, character, chapter); repeated writes upsert.
type CharacterState struct {
	ID          int64 `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID      int64 `gorm:"not null;default:0;index:idx_cs_novel,priority:1" json:"user_id"`
	NovelID     int64 `gorm:"not null;index:idx_cs_novel,priority:2" json:"novel_id"`
	CharacterID int64 `gorm:"not null;index:idx_cs_novel,priority:3" json:"character_id"`
	ChapterID   int64 `gorm:"not null;index:idx_cs_novel,priority:4" json:"chapter_id"`

	// KnownFacts is a JSON array of strings: facts the character has learned
	// by the end of ChapterID.
	KnownFacts datatypes.JSON `gorm:"type:jsonb" json:"known_facts"`
	// Possessions is a JSON array of strings the character currently holds.
	Possessions datatypes.JSON `gorm:"type:jsonb" json:"possessions"`
	Location    string         `gorm:"type:varchar(255)" json:"location"`
	Mood        string         `gorm:"type:varchar(255)" json:"mood"`

	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for CharacterState.
func (CharacterState) TableName() string {
	return "character_states"
}
