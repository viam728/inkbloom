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

// ForeshadowHint is one proactive nudge for the writing surface (plan A15).
// The bar renders the highest-priority hint only, so this ordering is what
// the author actually sees.
type ForeshadowHint struct {
	// Type is "overdue" (past its expected payoff chapter) or "upcoming"
	// (payoff due within the next couple of chapters).
	Type string `json:"type"`
	// Severity drives the bar's colour: "warn" for overdue, "info" for upcoming.
	Severity string `json:"severity"`
	// ForeshadowID lets the UI jump the tracker to this exact thread.
	ForeshadowID int64 `json:"foreshadow_id"`
	// Message is composed server-side so wording stays consistent across clients.
	Message string `json:"message"`
	// Only one of the two distance fields is meaningful per Type.
	ChaptersOverdue  int `json:"chapters_overdue"`
	ChaptersUntilDue int `json:"chapters_until_due"`
}

// HintsResponse carries the ordered nudges for one chapter.
type HintsResponse struct {
	Hints []ForeshadowHint `json:"hints"`
}

// ScanChapterResponse reports which threads were auto-resolved.
type ScanChapterResponse struct {
	Resolved []ForeshadowResponse `json:"resolved"`
	Scanned  int                  `json:"scanned"`
	// Degraded is true when the AI service was unreachable.
	Degraded bool `json:"degraded"`
}
