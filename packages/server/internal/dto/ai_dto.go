package dto

import "encoding/json"

// ChatMessage represents a single message in a chat conversation.
type ChatMessage struct {
	Role    string `json:"role" binding:"required"`    // system, user, assistant
	Content string `json:"content" binding:"required"` // message text
}

// ChatRequest is the request body for the AI chat endpoint.
type ChatRequest struct {
	Messages    []ChatMessage `json:"messages" binding:"required"`
	Model       string        `json:"model,omitempty"`
	Temperature float32       `json:"temperature,omitempty"`
	MaxTokens   int32         `json:"max_tokens,omitempty"`
	// Context fields — when provided, AI auto-injects novel/chapter context
	NovelID   int64 `json:"novel_id,omitempty"`
	ChapterID int64 `json:"chapter_id,omitempty"`
}

// ImagePromptRequest is the request body for the image prompt auto-generation endpoint.
type ImagePromptRequest struct {
	ContextText string `json:"context_text"`
	NovelID     int64  `json:"novel_id,omitempty"`
	ChapterID   int64  `json:"chapter_id,omitempty"`
	NovelGenre  string `json:"novel_genre,omitempty"`
	Style       string `json:"style,omitempty"` // realistic | anime | watercolor | oil_painting | ink_wash | digital_art
}

// ImagePromptResponse is the response for image prompt generation.
type ImagePromptResponse struct {
	Prompt         string `json:"prompt"`
	NegativePrompt string `json:"negative_prompt"`
}

// ChatChunkData represents a single SSE chunk sent to the client.
type ChatChunkData struct {
	Content      string `json:"content"`
	FinishReason string `json:"finish_reason,omitempty"`
}

// InlineRequest is the request body for the AI inline completion endpoint.
type InlineRequest struct {
	NovelID        int64  `json:"novel_id" binding:"required"`
	ChapterID      int64  `json:"chapter_id" binding:"required"`
	CursorPosition int    `json:"cursor_position"`
	PrecedingText  string `json:"preceding_text"`
	FollowingText  string `json:"following_text"`
}

// RewriteRequest is the request body for the AI rewrite endpoint.
type RewriteRequest struct {
	NovelID      int64  `json:"novel_id" binding:"required"`
	ChapterID    int64  `json:"chapter_id" binding:"required"`
	SelectedText string `json:"selected_text" binding:"required"`
	Action       string `json:"action" binding:"required"` // polish, expand, condense, humanize
}

// CandidatesRequest is the request body for POST /ai/candidates.
type CandidatesRequest struct {
	Action  string `json:"action" binding:"required"`
	Context string `json:"context" binding:"required"`
	Model   string `json:"model,omitempty"`
	N       int    `json:"n,omitempty"`
}

// CandidatesResponse is the upstream response for POST /ai/candidates.
type CandidatesResponse struct {
	Candidates []string `json:"candidates"`
}

// ReviewRequest is the request body for POST /ai/review.
type ReviewRequest struct {
	ChapterID int64  `json:"chapter_id" binding:"required"`
	Text      string `json:"text" binding:"required"`
}

// ReviewResponse is the upstream response for POST /ai/review.
// Annotations is kept raw to avoid structural drift with the Python service.
type ReviewResponse struct {
	Annotations json.RawMessage `json:"annotations"`
}

// InspirationRequest is the request body for POST /ai/inspiration.
type InspirationRequest struct {
	Category string `json:"category" binding:"required"` // plot | conflict | whatif | character
	Context  string `json:"context,omitempty"`
}

// InspirationResponse is the upstream response for POST /ai/inspiration.
type InspirationResponse struct {
	Items json.RawMessage `json:"items"`
}

// AnalyzeStoryRequest is the request body for POST /ai/analyze-story.
type AnalyzeStoryRequest struct {
	Title        string `json:"title" binding:"required"`
	ChapterCount int    `json:"chapter_count"`
	TotalWords   int    `json:"total_words"`
	OutlineActs  int    `json:"outline_acts"`
	OutlineNodes int    `json:"outline_nodes"`
	Characters   int    `json:"characters"`
}

// AnalyzeMediaRequest is the request body for POST /ai/analyze-media.
type AnalyzeMediaRequest struct {
	Title    string `json:"title" binding:"required"`
	Content  string `json:"content" binding:"required"`
	Platform string `json:"platform,omitempty"`
}

// AnalysisReportResponse is the upstream AnalysisReport shape shared by
// /ai/analyze-story and /ai/analyze-media.
type AnalysisReportResponse struct {
	Score       float64         `json:"score"`
	Summary     string          `json:"summary"`
	Dimensions  json.RawMessage `json:"dimensions"`
	Suggestions json.RawMessage `json:"suggestions"`
}

// ExpandOutlineRequest is the request body for POST /ai/expand-outline.
type ExpandOutlineRequest struct {
	OutlineTitle  string   `json:"outline_title" binding:"required"`
	Summary       string   `json:"summary" binding:"required"`
	MemoryContext []string `json:"memory_context,omitempty"`
	TargetWords   int      `json:"target_words,omitempty"`
}

// ExpandOutlineResponse is the upstream response for POST /ai/expand-outline.
type ExpandOutlineResponse struct {
	Draft string `json:"draft"`
}

// GenerateTitlesRequest is the request body for POST /ai/generate-titles.
type GenerateTitlesRequest struct {
	Topic    string `json:"topic" binding:"required"`
	Platform string `json:"platform" binding:"required"`
	Count    int    `json:"count,omitempty"`
}

// GenerateTitlesResponse is the upstream response for POST /ai/generate-titles.
type GenerateTitlesResponse struct {
	Titles json.RawMessage `json:"titles"`
}

// AdaptContentRequest is the request body for POST /ai/adapt-content.
type AdaptContentRequest struct {
	Content  string `json:"content" binding:"required"`
	Platform string `json:"platform" binding:"required"`
}

// AdaptContentResponse is the upstream response for POST /ai/adapt-content.
type AdaptContentResponse struct {
	Adapted string `json:"adapted"`
}

// PromptBuildRequest is the request body for POST /prompt/build.
type PromptBuildRequest struct {
	Context json.RawMessage `json:"context" binding:"required"`
	Type    string          `json:"type" binding:"required"`
}

// PromptBuildResponse is the upstream response for POST /prompt/build.
type PromptBuildResponse struct {
	Messages json.RawMessage `json:"messages"`
}

// AgentGenerateRequest is the request body for POST /ai/agent/generate.
// Scene must be one of: character, setting, summary, inspiration, outline.
// ItemID/NodeID are optional scene-specific anchors.
type AgentGenerateRequest struct {
	NovelID     int64   `json:"novel_id" binding:"required"`
	Scene       string  `json:"scene" binding:"required"`
	ItemID      *string `json:"item_id,omitempty"`
	NodeID      *string `json:"node_id,omitempty"`
	Instruction string  `json:"instruction,omitempty"`
}
