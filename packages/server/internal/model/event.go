package model

import (
	"time"

	"gorm.io/datatypes"
)

// Event is a product-analytics record (business plan v3 appendix B,
// construction plan A40).
//
// Privacy contract: Props carries identifiers and coarse counters ONLY —
// never chapter bodies, titles, or any user-authored text. The service layer
// enforces this by flattening values to scalars and truncating them.
//
// The table is append-only by convention: no UPDATE/DELETE path is exposed by
// the repository, matching the token_ledger approach.
type Event struct {
	ID    int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64 `gorm:"not null;default:0;index:idx_ev_name" json:"user_id"`
	// AnonymousID ties together events from a visitor who never logged in
	// (e.g. a reader browsing a published work). It is a client-generated
	// random id stored in localStorage, not a tracking cookie.
	AnonymousID string `gorm:"type:varchar(64);index" json:"anonymous_id,omitempty"`
	// SessionID scopes a burst of events to one page session.
	SessionID string `gorm:"type:varchar(64);index" json:"session_id,omitempty"`
	// Event is a lowercase snake_case name, e.g. "ai_generated".
	Event string `gorm:"type:varchar(64);not null;index:idx_ev_name" json:"event"`
	// Props is a flat JSON object of scalar values (string/number/bool).
	Props datatypes.JSON `gorm:"type:jsonb" json:"props,omitempty"`
	// OccurredAt is the client-side timestamp; CreatedAt is server receipt
	// time. They differ on offline/queued uploads, so both are kept.
	OccurredAt *time.Time `json:"occurred_at,omitempty"`
	CreatedAt  time.Time  `gorm:"autoCreateTime;index:idx_ev_time" json:"created_at"`
}

// TableName specifies the table name for Event.
func (Event) TableName() string {
	return "events"
}
