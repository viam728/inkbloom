package dto

import (
	"regexp"
	"time"
)

// Analytics event ingestion (business plan v3 appendix B, plan A40).

// MaxEventBatch caps how many events a single request may carry.
const MaxEventBatch = 50

// eventNameRe constrains event names to lowercase snake_case. Without it a
// buggy or hostile client could spray unbounded distinct names into the
// table and make every later GROUP BY useless.
var eventNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

// EventItem is one client-reported occurrence.
type EventItem struct {
	Event string `json:"event" binding:"required,max=64"`
	// Props must be flat scalars. Nested objects, arrays and long strings are
	// dropped or truncated server-side — see service.sanitizeProps.
	Props map[string]interface{} `json:"props,omitempty"`
	// TS is the client-side occurrence time (optional).
	TS *time.Time `json:"ts,omitempty"`
}

// ValidEventName reports whether name matches the snake_case contract.
func ValidEventName(name string) bool {
	return eventNameRe.MatchString(name)
}

// EventBatchRequest is the batch upload payload.
type EventBatchRequest struct {
	Events      []EventItem `json:"events" binding:"required,max=50"`
	AnonymousID string      `json:"anonymous_id" binding:"omitempty,max=64"`
	SessionID   string      `json:"session_id" binding:"omitempty,max=64"`
}

// EventBatchResponse reports how much of a batch survived validation.
type EventBatchResponse struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
}
