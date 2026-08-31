package model

import (
	"time"

	"gorm.io/datatypes"
)

// StoryJob stage enum (business plan v3, Agent 全本创作流水线, construction
// plan P1). The pipeline drives a job through these stages; each stage's
// materialised output is stored in StagePayload for preview/continuation.
const (
	// StageIdea is the user's one-sentence creative seed.
	StageIdea = "idea"
	// StageOutline expands the idea into a full act/node outline.
	StageOutline = "outline"
	// StagePlanChapters maps outline nodes to a concrete chapter list.
	StagePlanChapters = "plan_chapters"
	// StageDraftChapter writes one chapter's body at a time.
	StageDraftChapter = "draft_chapter"
	// StageVerify runs consistency + foreshadow checks on a draft.
	StageVerify = "verify"
	// StageFinalize marks the job complete (可逐章落库 done)。
	StageFinalize = "finalize"
	// StageDone is the terminal success state.
	StageDone = "done"
)

// StoryJob status enum.
const (
	StoryJobPending = "pending"
	StoryJobRunning = "running"
	StoryJobPaused  = "paused"
	StoryJobDone    = "done"
	StoryJobFailed  = "failed"
)

// StoryJob is a single end-to-end creation run (AI 起稿 → 全本创作流水线).
//
// The job is a persistent state machine: the author triggers it from a
// one-line idea, and the pipeline advances it stage by stage, writing each
// stage's output back into the real creation structures (novel_outline /
// chapters / novel_memory) after author confirmation. StagePayload keeps the
// transient stage output for preview and resumable continuation.
type StoryJob struct {
	ID        int64          `gorm:"primaryKey" json:"id"`
	UserID    int64          `gorm:"index;not null" json:"user_id"`
	NovelID   int64          `gorm:"index;not null" json:"novel_id"`
	Title     string         `gorm:"size:255" json:"title"`
	Logline   string         `gorm:"type:text" json:"logline"`
	Stage     string         `gorm:"size:64;not null;default:'idea'" json:"stage"`
	Status    string         `gorm:"size:32;not null;default:'pending'" json:"status"`
	Progress  int            `gorm:"not null;default:0" json:"progress"`
	TotalSteps int           `gorm:"not null;default:0" json:"total_steps"`
	// StagePayload holds the current stage output (outline acts / chapter
	// plan / drafted chapter preview / verify report) as JSONB.
	StagePayload datatypes.JSON `gorm:"type:jsonb" json:"stage_payload"`
	// Config holds the author's generation settings (chapter count, target
	// words per chapter, style, auto-settle toggle) as JSONB — the dynamic
	// sliders the workflow panel drives (plan P2-c).
	Config datatypes.JSON `gorm:"type:jsonb" json:"config"`
	// Result holds the terminal summary once the job reaches done.
	Result datatypes.JSON `gorm:"type:jsonb" json:"result"`
	// LastError records the most recent stage failure reason.
	LastError string `gorm:"type:text" json:"last_error"`
	ChapterKeys int          `gorm:"not null;default:0" json:"chapter_keys"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}
