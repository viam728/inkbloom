package dto

import "time"

// Foreshadow tracking (business plan v3 E2, construction plan A12).

// ForeshadowResponse is the client-facing thread record.
type ForeshadowResponse struct {
	ID              int64   `json:"id"`
	NovelID         int64   `json:"novel_id"`
	Description     string  `json:"description"`
	PlantChapterID  *int64  `json:"plant_chapter_id,omitempty"`
	PlantAnchor     string  `json:"plant_anchor,omitempty"`
	ExpectChapter   *int    `json:"expect_chapter,omitempty"`
	Status          string  `json:"status"`
	ResolveChapterID *int64 `json:"resolve_chapter_id,omitempty"`
	Source          string  `json:"source"`
	// PlantChapterTitle / ResolveChapterTitle are denormalised for the UI so
	// the tracker can render chapter names without a second round trip.
	PlantChapterTitle   string `json:"plant_chapter_title,omitempty"`
	ResolveChapterTitle string `json:"resolve_chapter_title,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CreateForeshadowRequest is the manual-registration payload.
type CreateForeshadowRequest struct {
	Description    string `json:"description" binding:"required,max=1000"`
	PlantChapterID *int64 `json:"plant_chapter_id,omitempty"`
	PlantAnchor    string `json:"plant_anchor" binding:"omitempty,max=500"`
	ExpectChapter  *int   `json:"expect_chapter,omitempty"`
	// Source may be "manual" (default) or "ai" when the record originates
	// from a confirmed AI candidate.
	Source string `json:"source" binding:"omitempty,oneof=manual ai"`
}

// UpdateForeshadowStatusRequest changes a thread's lifecycle state.
type UpdateForeshadowStatusRequest struct {
	// Status must be one of planted / reminded / resolved / abandoned.
	Status string `json:"status" binding:"required,oneof=planted reminded resolved abandoned"`
	// ResolveChapterID sets where the thread was paid off; required for
	// "resolved", ignored otherwise.
	ResolveChapterID *int64 `json:"resolve_chapter_id,omitempty"`
}

// ForeshadowCandidate is an AI-suggested thread awaiting author confirmation.
// Candidates are deliberately NOT persisted on generation.
type ForeshadowCandidate struct {
	Description   string `json:"description"`
	Anchor        string `json:"anchor"`
	ExpectChapter *int   `json:"expect_chapter,omitempty"`
	Confidence    float64 `json:"confidence"`
	Reason        string `json:"reason,omitempty"`
}

// DetectPlantsResponse returns AI candidates for a chapter.
type DetectPlantsResponse struct {
	Candidates []ForeshadowCandidate `json:"candidates"`
	// Degraded is true when the AI service was unreachable. The UI surfaces
	// this instead of showing an empty list as if nothing was found.
	Degraded bool `json:"degraded"`
}

// ScanChapterResponse reports which threads were auto-resolved.
type ScanChapterResponse struct {
	Resolved []ForeshadowResponse `json:"resolved"`
	Scanned  int                  `json:"scanned"`
	// Degraded is true when the AI service was unreachable.
	Degraded bool `json:"degraded"`
}
