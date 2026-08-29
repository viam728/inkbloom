package dto

import (
	"encoding/json"
	"time"
)

// Chapter version history (business plan v3 E1, construction plan A05).

// ChapterVersionSummary is the list-shaped version payload. It deliberately
// omits content so that listing a long chapter's history stays cheap.
type ChapterVersionSummary struct {
	ID          int64     `json:"id"`
	ChapterID   int64     `json:"chapter_id"`
	NovelID     int64     `json:"novel_id"`
	Title       string    `json:"title"`
	WordCount   int       `json:"word_count"`
	Kind        string    `json:"kind"`
	Label       string    `json:"label,omitempty"`
	ContentHash string    `json:"content_hash"`
	CreatedAt   time.Time `json:"created_at"`
}

// ChapterVersionDetail carries the full snapshot body, returned only when a
// single version is fetched. ContentJSON stays a raw message so the TipTap
// document is passed through verbatim instead of being base64-encoded.
type ChapterVersionDetail struct {
	ChapterVersionSummary
	Content     string          `json:"content,omitempty"`
	ContentJSON json.RawMessage `json:"content_json,omitempty"`
}

// CreateVersionRequest is the manual-checkpoint payload.
type CreateVersionRequest struct {
	// Kind must be "milestone" or "ai_rewrite". Automatic ("auto") snapshots
	// are produced by the server and cannot be requested through the API.
	Kind string `json:"kind" binding:"omitempty,oneof=milestone ai_rewrite"`
	// Label is an optional human name for the checkpoint.
	Label string `json:"label" binding:"omitempty,max=255"`
}

// VersionListResponse wraps the version list plus the retention hint so the UI
// can tell the author how long history is kept on their plan.
type VersionListResponse struct {
	Versions []ChapterVersionSummary `json:"versions"`
	Total    int64                   `json:"total"`
	Limit    int                     `json:"limit"`
	Offset   int                     `json:"offset"`
	// Retention tells the author how long automatic snapshots survive on
	// their current plan (A07). MaxDays 0 means unlimited.
	Retention *RetentionInfo `json:"retention,omitempty"`
}

// RetentionInfo is the client-facing shape of service.Retention.
type RetentionInfo struct {
	KeepCount int    `json:"keep_count"`
	MaxDays   int    `json:"max_days"`
	Tier      string `json:"tier"`
}
