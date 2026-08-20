package dto

import (
	"encoding/json"
	"time"
)

// Payload ceilings are encoded in the binding tags below: content ≤ 1MB
// (max=1048576), title ≤ 255, tags ≤ 50 items of ≤ 100 chars each.

// CreateMediaContentRequest is the request body for POST /media/contents.
// Frontend contract: media-client.ts createMediaContent.
type CreateMediaContentRequest struct {
	Title    string   `json:"title" binding:"required,max=255"`
	Platform string   `json:"platform" binding:"required,oneof=wechat xiaohongshu weibo video"`
	Content  string   `json:"content" binding:"max=1048576"`
	Tags     []string `json:"tags" binding:"omitempty,max=50,dive,max=100"`
}

// UpdateMediaContentRequest is the request body for PUT /media/contents/:id.
// Pointer fields enable partial updates (frontend sends Partial<MediaContent>).
type UpdateMediaContentRequest struct {
	Title    *string   `json:"title,omitempty" binding:"omitempty,max=255"`
	Platform *string   `json:"platform,omitempty" binding:"omitempty,oneof=wechat xiaohongshu weibo video"`
	Content  *string   `json:"content,omitempty" binding:"omitempty,max=1048576"`
	Tags     *[]string `json:"tags,omitempty" binding:"omitempty,max=50,dive,max=100"`
}

// ReorderMediaContentsRequest is the request body for PUT /media/contents/order.
// Full id list in the desired order; positions are rewritten to 0..n-1.
type ReorderMediaContentsRequest struct {
	OrderedIDs []int64 `json:"ordered_ids" binding:"required"`
}

// MediaContentResponse is the response body for a single media content entry.
// Field names follow packages/web/src/types/media.ts MediaContent.
type MediaContentResponse struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Platform  string    `json:"platform"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// TopicItem mirrors packages/web/src/types/media.ts TopicItem. It is used both
// in the GET response and in the full-replacement POST request body.
type TopicItem struct {
	ID        string    `json:"id"`
	Title     string    `json:"title" binding:"required,max=255"`
	Note      string    `json:"note"`
	Status    string    `json:"status" binding:"omitempty,oneof=idea used dropped"`
	CreatedAt time.Time `json:"created_at"`
}

// SaveTopicsRequest is the request body for POST /media/topics: the complete
// topic list replaces the stored set atomically (idempotent).
type SaveTopicsRequest struct {
	Topics []TopicItem `json:"topics" binding:"dive"`
}

// UpdateMediaMemoryRequest is the request body for PUT /media/memory
// (whole-document replacement). Version is an optional optimistic-concurrency
// hint; payload limits are enforced by the service layer (2MB, JSON array).
type UpdateMediaMemoryRequest struct {
	Items   json.RawMessage `json:"items"`
	Version *int            `json:"version"`
}

// MediaMemoryResponse is the data shape of GET/PUT /media/memory responses.
// Items is passed through verbatim; no Go-side MemoryItem struct to avoid
// schema drift with the frontend.
type MediaMemoryResponse struct {
	Items   json.RawMessage `json:"items"`
	Version int             `json:"version"`
}
