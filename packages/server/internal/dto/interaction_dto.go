package dto

import (
	"encoding/json"
	"time"
)

// Reader-interaction DTOs (business plan v3 E5, construction plan A28).

// CreateInteractionRequest posts a comment or mood to a published chapter.
type CreateInteractionRequest struct {
	// Type is "comment" or "mood".
	Type string `json:"type" binding:"required,oneof=comment mood"`
	// BlockIndex anchors the interaction to a rendered block (data-block-index).
	BlockIndex int `json:"block_index"`
	// Anchor is the exact selected text, for line comments.
	Anchor string `json:"anchor" binding:"omitempty,max=500"`
	// Payload is type-specific: comment → {"text":"..."}, mood → {"mood":"fire"}.
	Payload json.RawMessage `json:"payload,omitempty"`
}

// InteractionDTO is the public projection of an interaction.
type InteractionDTO struct {
	ID         int64           `json:"id"`
	ChapterID  int64           `json:"chapter_id"`
	UserID     int64           `json:"user_id"`
	Nickname   string          `json:"nickname,omitempty"`
	Type       string          `json:"type"`
	BlockIndex int             `json:"block_index"`
	Anchor     string          `json:"anchor,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	Status     string          `json:"status"`
	LikeCount  int             `json:"like_count"`
	LikedByMe  bool            `json:"liked_by_me"`
	IsAuthor   bool            `json:"is_author"`
	CreatedAt  time.Time       `json:"created_at"`
}

// InteractionListResponse lists a chapter's interactions plus a flag telling
// the reader UI whether the current viewer is the work's author (to reveal
// adopt/author actions).
type InteractionListResponse struct {
	Interactions []InteractionDTO `json:"interactions"`
	IsAuthor     bool             `json:"is_author"`
}

// LikeResponse reports the resulting like state after a toggle.
type LikeResponse struct {
	InteractionID int64 `json:"interaction_id"`
	LikeCount     int   `json:"like_count"`
	Liked         bool  `json:"liked"`
}
