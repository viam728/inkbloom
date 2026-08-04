package dto

import "time"

// CreateNovelRequest is the request body for creating a novel.
type CreateNovelRequest struct {
	Title       string `json:"title" binding:"required,max=255"`
	Genre       string `json:"genre,omitempty"`
	Description string `json:"description,omitempty"`
	CoverImage  string `json:"cover_image,omitempty"`
}

// UpdateNovelRequest is the request body for updating a novel.
type UpdateNovelRequest struct {
	Title       *string `json:"title,omitempty"`
	Genre       *string `json:"genre,omitempty"`
	Description *string `json:"description,omitempty"`
	CoverImage  *string `json:"cover_image,omitempty"`
	Status      *string `json:"status,omitempty"`
}

// NovelResponse is the response body for a single novel.
type NovelResponse struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	Genre       string    `json:"genre"`
	Description string    `json:"description"`
	CoverImage  string    `json:"cover_image"`
	WordCount   int       `json:"word_count"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ListNovelsResponse is the response body for listing novels.
type ListNovelsResponse struct {
	Novels []NovelResponse `json:"novels"`
	Total  int64           `json:"total"`
}
