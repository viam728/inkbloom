package model

import (
	"time"
)

// User status values.
const (
	UserStatusActive    int16 = 0 // normal
	UserStatusDisabled  int16 = 1 // banned
	UserStatusCoolDown  int16 = 2 // deregistration cool-down
	UserStatusCancelled int16 = 3 // deregistered
)

// User role values.
const (
	RoleUser       int16 = 0
	RoleOperator   int16 = 1 // back-office operator
	RoleSuperAdmin int16 = 2 // super admin (reserved, task #49)
)

// User represents an account in the users table (migration 007).
// Unique constraints are on nullable columns so multiple NULLs coexist.
type User struct {
	ID                int64      `gorm:"primaryKey;autoIncrement" json:"id"`
	Phone             *string    `gorm:"type:varchar(20);uniqueIndex" json:"phone,omitempty"`
	Email             *string    `gorm:"type:varchar(255);uniqueIndex" json:"email,omitempty"`
	PasswordHash      *string    `gorm:"type:text;column:password_hash" json:"-"`
	WechatOpenid      *string    `gorm:"type:varchar(64);uniqueIndex;column:wechat_openid" json:"-"`
	WechatUnionid     *string    `gorm:"type:varchar(64);column:wechat_unionid" json:"-"`
	Nickname          string     `gorm:"type:varchar(64);not null" json:"nickname"`
	AvatarURL         *string    `gorm:"type:varchar(500);column:avatar_url" json:"avatar_url,omitempty"`
	Status            int16      `gorm:"type:smallint;not null;default:0" json:"status"`
	Role              int16      `gorm:"type:smallint;not null;default:0" json:"role"`
	RegisteredChannel string     `gorm:"type:varchar(20);not null;default:'sms';column:registered_channel" json:"registered_channel"`
	LastLoginAt       *time.Time `gorm:"column:last_login_at" json:"last_login_at,omitempty"`
	// AgreedTermsAt records when the user accepted the terms/privacy policy
	// at registration (tech plan v2 §9.2). NULL for pre-v2 accounts.
	AgreedTermsAt *time.Time `gorm:"column:agreed_terms_at" json:"agreed_terms_at,omitempty"`
	CreatedAt     time.Time  `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt     time.Time  `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName specifies the table name for User.
func (User) TableName() string {
	return "users"
}
