package dto

import "time"

// Publishing & reading DTOs (business plan v3 E4, plan A17).

// CreateWorkRequest creates or replaces the published face of a novel.
type CreateWorkRequest struct {
	NovelID    int64  `json:"novel_id" binding:"required"`
	Title      string `json:"title" binding:"required,max=255"`
	Synopsis   string `json:"synopsis" binding:"omitempty,max=2000"`
	CoverURL   string `json:"cover_url" binding:"omitempty,url"`
	Visibility string `json:"visibility" binding:"omitempty,oneof=public unlisted private"`
	// Slug is optional. When omitted the server derives one from the title;
	// when supplied it must match `^[a-z0-9][a-z0-9-]{2,118}[a-z0-9]$`.
	Slug string `json:"slug" binding:"omitempty,max=120"`
}

// UpdateWorkRequest changes editable fields of an existing published work.
type UpdateWorkRequest struct {
	Title      *string `json:"title,omitempty" binding:"omitempty,max=255"`
	Synopsis   *string `json:"synopsis,omitempty" binding:"omitempty,max=2000"`
	CoverURL   *string `json:"cover_url,omitempty"`
	Visibility *string `json:"visibility,omitempty" binding:"omitempty,oneof=public unlisted private"`
}

// PublishChapterRequest publishes one chapter of an already-published work.
type PublishChapterRequest struct {
	ChapterID  int64      `json:"chapter_id" binding:"required"`
	ScheduledAt *time.Time `json:"scheduled_at,omitempty"`
}

// WorkResponse is the author-facing published-work record.
type WorkResponse struct {
	ID          int64     `json:"id"`
	NovelID     int64     `json:"novel_id"`
	Slug        string    `json:"slug"`
	Title       string    `json:"title"`
	Synopsis    string    `json:"synopsis"`
	CoverURL    string    `json:"cover_url"`
	Visibility  string    `json:"visibility"`
	AIInspired  bool      `json:"ai_inspired"`
	FollowCount int       `json:"follow_count"`
	// AIInspiredSource explains how AIInspired was derived. "chapter" =
	// at least one chapter has an ai_rewrite snapshot (precise). "author"
	// = the author has any ai_call ledger entry (user-level fallback,
	// may over-flag works where the AI edit went into a different piece).
	// Empty means not AI-assisted.
	AIInspiredSource string `json:"ai_inspired_source,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// PublishedChapterResponse is the author-facing published-chapter record.
type PublishedChapterResponse struct {
	ID           int64      `json:"id"`
	WorkID       int64      `json:"work_id"`
	ChapterID    int64      `json:"chapter_id"`
	VersionID    *int64     `json:"version_id,omitempty"`
	Title        string     `json:"title"`
	WordCount    int        `json:"word_count"`
	Position     int        `json:"position"`
	ScheduledAt  *time.Time `json:"scheduled_at,omitempty"`
	PublishedAt  time.Time  `json:"published_at"`
}

// ChapterStatsDTO is one bar of the read-through funnel (plan A23).
// ReaderCount is how many readers' latest reading position currently sits on
// this chapter — an honest proxy for the drop-off funnel given the
// progress model stores only each reader's last position.
type ChapterStatsDTO struct {
	ChapterID   int64  `json:"chapter_id"`
	Title       string `json:"title"`
	Position    int    `json:"position"`
	ReaderCount int64  `json:"reader_count"`
}

// WorkStatsResponse is the author dashboard's read-statistics payload (A23).
type WorkStatsResponse struct {
	WorkID      int64             `json:"work_id"`
	FollowCount int64             `json:"follow_count"`
	// ReaderCount is the number of distinct readers who have any progress.
	ReaderCount int64             `json:"reader_count"`
	Chapters    []ChapterStatsDTO `json:"chapters"`
}

// BlockEmotionsDTO is one paragraph's emotion counts (plan A31).
type BlockEmotionsDTO struct {
	BlockIndex int            `json:"block_index"`
	Moods      map[string]int `json:"moods"` // fire/knife/sweet/mystery
}

// ChapterEmotionsResponse is the per-chapter emotion aggregation powering the
// author dashboard's「章节情绪曲线」(plan A31).
type ChapterEmotionsResponse struct {
	ChapterID int64             `json:"chapter_id"`
	// Totals: mood key → count across the whole chapter.
	Totals    map[string]int    `json:"totals"`
	// Blocks: one row per block that received any emotion, ordered by index.
	Blocks    []BlockEmotionsDTO `json:"blocks"`
}
