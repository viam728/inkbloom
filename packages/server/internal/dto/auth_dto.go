package dto

import "time"

// SendSMSCodeRequest is the payload of POST /api/v1/auth/sms-code.
type SendSMSCodeRequest struct {
	Phone string `json:"phone" binding:"required"`
}

// SendSMSCodeResponse is returned after a code is issued.
type SendSMSCodeResponse struct {
	ExpiresIn int64 `json:"expires_in"` // seconds the code stays valid
}

// RegisterRequest is the payload of POST /api/v1/auth/register.
type RegisterRequest struct {
	Phone    string `json:"phone" binding:"required"`
	Code     string `json:"code" binding:"required"`
	Password string `json:"password" binding:"required"`
	Nickname string `json:"nickname"` // optional
	// AgreedTerms must be true: the user must accept the terms + privacy
	// policy before registering (tech plan v2 §9.2).
	AgreedTerms bool `json:"agreed_terms"`
}

// LoginRequest is the payload of POST /api/v1/auth/login.
// code and password are mutually optional; when both are given, code wins.
type LoginRequest struct {
	Phone    string `json:"phone" binding:"required"`
	Password string `json:"password"`
	Code     string `json:"code"`
}

// RefreshRequest is the payload of POST /api/v1/auth/refresh.
type RefreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

// LogoutRequest is the optional payload of POST /api/v1/auth/logout.
// When refresh_token is given only that session is revoked.
type LogoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// UserDTO is the public projection of a user account.
type UserDTO struct {
	ID        int64  `json:"id"`
	Phone     string `json:"phone,omitempty"`
	Nickname  string `json:"nickname"`
	AvatarURL string `json:"avatar_url,omitempty"`
	// Role is the account role (0 user / 1+ back-office, task #49).
	Role      int16     `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

// AuthResponse is returned by register / login / refresh.
type AuthResponse struct {
	User         UserDTO `json:"user"`
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	TokenType    string  `json:"token_type"`
	// ExpiresIn is the access token lifetime in seconds.
	ExpiresIn int64 `json:"expires_in"`
}

// MeResponse is returned by GET /api/v1/auth/me.
type MeResponse struct {
	User UserDTO `json:"user"`
}
