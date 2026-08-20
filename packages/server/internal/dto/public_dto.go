package dto

// PublicFlags is the GET /api/v1/public/flags payload (task #51, M6).
// Enabled is only present for authenticated callers (Bearer token).
type PublicFlags struct {
	Features       map[string]bool `json:"features"`
	RolloutPercent int             `json:"rollout_percent"`
	ServerVersion  string          `json:"server_version"`
	Enabled        *bool           `json:"enabled,omitempty"`
	// MinDesktopVersion is the minimum supported desktop client version
	// (tech plan v2 §7.1). Empty means "no floor" (all versions allowed).
	// Older clients must block cloud writes and prompt an update.
	MinDesktopVersion string `json:"min_desktop_version,omitempty"`
}
