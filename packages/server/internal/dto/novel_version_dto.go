package dto

import (
	"encoding/json"
	"time"
)

// Whole-novel milestone snapshots (Agent safety work Q3).

// NovelSnapshot is the whole-novel bundle stored in novel_versions.snapshot.
// Chapters, outline and memory are captured at the same instant so a single
// restore rewinds the book as a unit instead of leaving outline node
// chapter_id links dangling.
type NovelSnapshot struct {
	Chapters []NovelSnapshotChapter `json:"chapters"`
	Outline  NovelSnapshotOutline   `json:"outline"`
	Memory   NovelSnapshotMemory    `json:"memory"`
}

// NovelSnapshotChapter is one chapter inside a bundle. The id is preserved on
// restore on purpose: outline nodes reference it through chapter_id.
type NovelSnapshotChapter struct {
	ID          int64           `json:"id"`
	Title       string          `json:"title"`
	Content     string          `json:"content"`
	ContentJSON json.RawMessage `json:"content_json"`
	Summary     string          `json:"summary"`
	Status      string          `json:"status"`
	Position    int             `json:"position"`
	// SortOrder is the frontend-compatible alias of Position.
	SortOrder int    `json:"sort_order"`
	WordCount int    `json:"word_count"`
	VolumeID  *int64 `json:"volume_id"`
}

// NovelSnapshotOutline carries the outline acts verbatim (no Go-side struct,
// to avoid schema drift with the frontend) plus the document version it came
// from, which is diagnostic only — a restore always replaces wholesale.
type NovelSnapshotOutline struct {
	Acts    json.RawMessage `json:"acts"`
	Version int             `json:"version"`
}

// NovelSnapshotMemory carries the memory items verbatim.
type NovelSnapshotMemory struct {
	Items   json.RawMessage `json:"items"`
	Version int             `json:"version"`
}

// CreateNovelVersionRequest is the manual whole-novel checkpoint payload.
type CreateNovelVersionRequest struct {
	// Label is an optional human name for the checkpoint.
	Label string `json:"label" binding:"omitempty,max=255"`
}

// RestoreNovelVersionRequest selects how far a restore is allowed to go.
type RestoreNovelVersionRequest struct {
	// Mode is "conservative" (default) or "full".
	//   - conservative: updates chapters that still exist, never recreates a
	//     deleted chapter and never deletes a chapter written after the
	//     snapshot. The safe default.
	//   - full: additionally recreates missing chapters (keeping their
	//     original ids) and deletes chapters absent from the snapshot.
	Mode string `json:"mode" binding:"omitempty,oneof=conservative full"`
}

// NovelVersionSummary is the list-shaped payload. It deliberately omits the
// snapshot so listing a novel's history never drags whole book bundles over
// the wire.
type NovelVersionSummary struct {
	ID           int64     `json:"id"`
	NovelID      int64     `json:"novel_id"`
	Title        string    `json:"title"`
	Kind         string    `json:"kind"`
	Label        string    `json:"label,omitempty"`
	ContentHash  string    `json:"content_hash"`
	ChapterCount int       `json:"chapter_count"`
	WordCount    int       `json:"word_count"`
	CreatedAt    time.Time `json:"created_at"`
}

// NovelVersionDetail carries the full bundle, returned only when a single
// version is fetched.
type NovelVersionDetail struct {
	NovelVersionSummary
	Snapshot *NovelSnapshot `json:"snapshot,omitempty"`
}

// RestoreResult reports what a restore actually did, so the UI can tell the
// author exactly which chapters came back and which were left alone.
type RestoreResult struct {
	// CheckpointID is the pre-restore snapshot of the state that was
	// overwritten. Zero when the checkpoint could not be written.
	CheckpointID int64 `json:"checkpoint_id"`
	Created      int   `json:"created"`
	Updated      int   `json:"updated"`
	Deleted      int   `json:"deleted"`
	// Missing counts chapters in the snapshot that no longer exist.
	// Conservative mode skips them; full mode recreates them.
	Missing int `json:"missing"`
	// Extra counts current chapters absent from the snapshot. Conservative
	// mode leaves them; full mode deletes them.
	Extra int `json:"extra"`
	// Mode echoes the mode actually applied, which matters because an empty
	// or unrecognized mode falls back to conservative.
	Mode string `json:"mode"`
}

// NovelVersionListResponse wraps the version list plus the cursor metadata the
// history panel paginates with.
type NovelVersionListResponse struct {
	Versions []NovelVersionSummary `json:"versions"`
	Total    int64                 `json:"total"`
	Limit    int                   `json:"limit"`
	Offset   int                   `json:"offset"`
}
