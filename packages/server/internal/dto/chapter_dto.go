package dto

import (
	"encoding/json"
	"time"
)

// CreateChapterRequest is the request body for creating a chapter.
type CreateChapterRequest struct {
	NovelID  int64  `json:"novel_id" binding:"required"`
	VolumeID *int64 `json:"volume_id,omitempty"`
	Title    string `json:"title" binding:"required,max=255"`
	Content  string `json:"content,omitempty"`
	// Position is the optional 0-based insertion index within the novel's
	// chapter list (frontend contract: novel-store.ts createChapter). When
	// omitted, the chapter is appended at the end.
	Position *int `json:"position,omitempty"`
}

// ReorderChaptersRequest is the request body for batch reordering chapters.
// Frontend contract: PUT /novels/:id/chapters/order { ordered_ids: number[] }.
type ReorderChaptersRequest struct {
	OrderedIDs []int64 `json:"ordered_ids" binding:"required"`
}

// UpdateChapterRequest is the request body for updating a chapter.
type UpdateChapterRequest struct {
	Title       *string          `json:"title,omitempty"`
	Content     *string          `json:"content,omitempty"`
	ContentJSON *json.RawMessage `json:"content_json,omitempty"`
	Summary     *string          `json:"summary,omitempty"`
	Status      *string          `json:"status,omitempty"`
}

// ChapterResponse is the response body for a single chapter.
type ChapterResponse struct {
	ID        int64  `json:"id"`
	NovelID   int64  `json:"novel_id"`
	VolumeID  *int64 `json:"volume_id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	WordCount int    `json:"word_count"`
	Position  int    `json:"position"`
	// SortOrder 前端兼容别名（前端 Chapter.sort_order 只认该字段），与 Position 同值，下迭代收敛。
	SortOrder   int             `json:"sort_order"`
	ContentJSON json.RawMessage `json:"content_json,omitempty"`
	Summary     string          `json:"summary"`
	Status      string          `json:"status"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

