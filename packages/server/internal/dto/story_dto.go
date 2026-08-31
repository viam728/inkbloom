package dto

import (
	"encoding/json"
	"time"
)

// CreateStoryJobRequest starts a full-book creation run from a one-line idea.
type CreateStoryJobRequest struct {
	NovelID int64  `json:"novel_id" binding:"required"`
	Title   string `json:"title" binding:"required,max=255"`
	Logline string `json:"logline" binding:"required"`
	// Config carries optional generation settings (dynamic sliders):
	//   chapter_count, words_per_chapter, style, auto_settle.
	Config json.RawMessage `json:"config,omitempty"`
}

// StoryJobResponse is the persisted job state returned to the client.
type StoryJobResponse struct {
	ID          int64           `json:"id"`
	NovelID     int64           `json:"novel_id"`
	Title       string          `json:"title"`
	Logline     string          `json:"logline"`
	Stage       string          `json:"stage"`
	Status      string          `json:"status"`
	Progress    int             `json:"progress"`
	TotalSteps  int             `json:"total_steps"`
	StagePayload json.RawMessage `json:"stage_payload"`
	Config      json.RawMessage `json:"config"`
	Result      json.RawMessage `json:"result"`
	LastError   string          `json:"last_error"`
	ChapterKeys int             `json:"chapter_keys"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// GenerateStageRequest advances the job to generate the current stage's
// preview output (does not persist into the real structures yet).
type GenerateStageRequest struct {
	// Instruction is an optional per-run directive (e.g. "改写成悬疑风格").
	Instruction string `json:"instruction,omitempty"`
}

// AdoptChapterRequest confirms a drafted chapter and writes it into the
// novel's chapters table.
type AdoptChapterRequest struct {
	ChapterKey string `json:"chapter_key" binding:"required"`
	Title      string `json:"title"`
	Content    string `json:"content" binding:"required"`
}

// ListStoryJobsResponse is the paginated listing.
type ListStoryJobsResponse struct {
	Jobs []StoryJobResponse `json:"jobs"`
	Total int64             `json:"total"`
	Page  int               `json:"page"`
	PageSize int            `json:"page_size"`
}
