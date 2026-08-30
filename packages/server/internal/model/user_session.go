package model

import "time"

// Session device types (business plan v3 T2, construction plan A22).
const (
	DeviceWeb     = "web"
	DeviceDesktop = "desktop"
	DeviceMobile  = "mobile"
)

// UserSession is a persisted authentication session.
//
// It replaces the Redis/in-memory-only refresh-token storage so sessions
// survive a desktop (embedded server) restart and can be listed and revoked
// per device. The sliding refresh window is enforced through ExpiresAt: each
// refresh consumes the old session and mints a new one with a fresh expiry.
type UserSession struct {
	ID     int64  `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID int64  `gorm:"not null;index:idx_us_user,priority:1" json:"user_id"`
	// JTI is the refresh token's jti claim. Globally unique so a presented
	// token can be looked up and atomically consumed on rotation.
	JTI        string `gorm:"type:varchar(64);not null;uniqueIndex" json:"jti"`
	DeviceName string `gorm:"type:varchar(120)" json:"device_name"`
	DeviceType string `gorm:"type:varchar(20)" json:"device_type"`
	IP         string `gorm:"type:varchar(64)" json:"ip"`

	LastActiveAt time.Time `gorm:"index:idx_us_user,priority:2" json:"last_active_at"`
	ExpiresAt    time.Time `gorm:"not null;index" json:"expires_at"`
	CreatedAt    time.Time `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for UserSession.
func (UserSession) TableName() string { return "user_sessions" }
