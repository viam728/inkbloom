package dto

import "time"

// ImageUploadResult is the frozen data payload of POST /api/v1/images
// (task #57). Field names are an API contract shared with the frontend.
// Note: the upload response uses "size"; the listing items use "file_size".
type ImageUploadResult struct {
	ID           int64  `json:"id"`
	URL          string `json:"url"`
	ThumbURL     string `json:"thumb_url"`
	ContentHash  string `json:"content_hash"`
	DisplayName  string `json:"display_name"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Size         int64  `json:"size"`
	Scope        string `json:"scope"`
	Source       string `json:"source"`
	Deduplicated bool   `json:"deduplicated"`
}

// ImageItem is one row of the gallery listing (GET /api/v1/images).
type ImageItem struct {
	ID          int64     `json:"id"`
	URL         string    `json:"url"`
	ThumbURL    string    `json:"thumb_url"`
	ContentHash string    `json:"content_hash"`
	DisplayName string    `json:"display_name"`
	Width       int32     `json:"width"`
	Height      int32     `json:"height"`
	FileSize    int32     `json:"file_size"`
	Scope       string    `json:"scope"`
	Source      string    `json:"source"`
	NovelID     *int64    `json:"novel_id"`
	CreatedAt   time.Time `json:"created_at"`
}

// ImageListResult is the frozen data payload of GET /api/v1/images.
type ImageListResult struct {
	Items      []ImageItem `json:"items"`
	NextCursor string      `json:"next_cursor"`
}

// ImageBatchDeleteRequest is the body of POST /api/v1/images/batch-delete.
type ImageBatchDeleteRequest struct {
	IDs []int64 `json:"ids"`
}

// ImageBatchDeleteResult is the frozen data payload of batch-delete.
// Referenced images land in Skipped instead of failing the whole batch.
type ImageBatchDeleteResult struct {
	Deleted int     `json:"deleted"`
	Skipped []int64 `json:"skipped"`
}
