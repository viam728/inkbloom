package model

import (
	"time"

	"gorm.io/datatypes"
)

// Interaction types (business plan v3 E5, construction plan A28).
const (
	// InteractionComment is a reader's line/paragraph comment.
	InteractionComment = "comment"
	// InteractionMood is a one-click paragraph emotion (fire/knife/sweet/mystery).
	InteractionMood = "mood"
)

// Interaction statuses.
const (
	// InteractionStatusPending is the default: visible, not yet acted on.
	InteractionStatusPending = "pending"
	// InteractionStatusAdopted means the author acknowledged/incorporated it.
	InteractionStatusAdopted = "adopted"
	// InteractionStatusHidden is soft-deleted (author or commenter removed it).
	InteractionStatusHidden = "hidden"
)

// Mood keys for InteractionMood payloads.
const (
	MoodFire     = "fire"     // 燃
	MoodKnife    = "knife"    // 刀
	MoodSweet    = "sweet"    // 甜
	MoodMystery  = "mystery"  // 谜
)

// Interaction is a reader's engagement with a published chapter (plan A28).
//
// It is anchored to a block of the rendered chapter via BlockIndex (matches
// the data-block-index attribute the reader renders onto top-level nodes) and
// optionally an Anchor (the exact selected text). Payload is shape-dependent:
// comment → {"text": "..."}; mood → {"mood": "fire"}.
type Interaction struct {
	ID        int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    int64  `gorm:"not null;index:idx_it_chapter,priority:1" json:"user_id"`
	// ChapterID references published_chapters.id (the frozen public copy).
	ChapterID int64 `gorm:"not null;index:idx_it_chapter,priority:2" json:"chapter_id"`
	Type      string `gorm:"type:varchar(20);not null;index:idx_it_chapter,priority:3" json:"type"`
	BlockIndex int   `gorm:"not null;default:0" json:"block_index"`
	Anchor    string `gorm:"type:varchar(500)" json:"anchor,omitempty"`
	Payload   datatypes.JSON `gorm:"type:jsonb" json:"payload,omitempty"`
	Status    string `gorm:"type:varchar(20);not null;default:'pending'" json:"status"`
	LikeCount int    `gorm:"not null;default:0" json:"like_count"`

	CreatedAt time.Time `gorm:"autoCreateTime;index:idx_it_chapter,priority:4" json:"created_at"`
}

// TableName specifies the table name for Interaction.
func (Interaction) TableName() string { return "interactions" }

// InteractionVote is a like on an interaction (plan A28). (interaction_id,
// user_id) is unique: a reader toggles their like rather than stacking votes.
type InteractionVote struct {
	ID            int64 `gorm:"primaryKey;autoIncrement" json:"id"`
	InteractionID int64 `gorm:"not null;uniqueIndex:idx_iv_pair,priority:1" json:"interaction_id"`
	UserID        int64 `gorm:"not null;uniqueIndex:idx_iv_pair,priority:2" json:"user_id"`
	Value         int   `gorm:"not null;default:1" json:"value"`

	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for InteractionVote.
func (InteractionVote) TableName() string { return "interaction_votes" }
