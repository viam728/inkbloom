package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/service"
)

// AuthHandler handles account-system HTTP requests (/api/v1/auth/*).
type AuthHandler struct {
	authService *service.AuthService
}

// NewAuthHandler creates a new AuthHandler.
func NewAuthHandler(as *service.AuthService) *AuthHandler {
	return &AuthHandler{authService: as}
}

// SendSMSCode handles POST /api/v1/auth/sms-code
func (h *AuthHandler) SendSMSCode(c *gin.Context) {
	var req dto.SendSMSCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.authService.SendCode(c.Request.Context(), req.Phone); err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.SendSMSCodeResponse{ExpiresIn: 300}})
}

// Register handles POST /api/v1/auth/register
func (h *AuthHandler) Register(c *gin.Context) {
	var req dto.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	user, pair, err := h.authService.Register(c.Request.Context(), req.Phone, req.Code, req.Password, req.Nickname, req.AgreedTerms)
	if err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "registered", Data: authResponse(user, pair)})
}

// Login handles POST /api/v1/auth/login
func (h *AuthHandler) Login(c *gin.Context) {
	var req dto.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	user, pair, err := h.authService.Login(c.Request.Context(), req.Phone, req.Password, req.Code)
	if err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: authResponse(user, pair)})
}

// Refresh handles POST /api/v1/auth/refresh
func (h *AuthHandler) Refresh(c *gin.Context) {
	var req dto.RefreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	user, pair, err := h.authService.Refresh(c.Request.Context(), req.RefreshToken)
	if err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: authResponse(user, pair)})
}

// Logout handles POST /api/v1/auth/logout (requires Bearer access token).
func (h *AuthHandler) Logout(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	var req dto.LogoutRequest
	// Body is optional; ignore bind errors on empty body.
	_ = c.ShouldBindJSON(&req)

	if err := h.authService.Logout(c.Request.Context(), uid, req.RefreshToken); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "logged out"})
}

// Me handles GET /api/v1/auth/me (requires Bearer access token).
func (h *AuthHandler) Me(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	user, err := h.authService.Me(c.Request.Context(), uid)
	if err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.MeResponse{User: toUserDTO(user)}})
}

// Deregister handles POST /api/v1/auth/deregister (requires Bearer access
// token): marks the account as cool-down and revokes all sessions (v2 §9.2).
func (h *AuthHandler) Deregister(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}
	if err := h.authService.RequestDeregistration(c.Request.Context(), uid); err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deregistration cool-down started"})
}

// CancelDeregister handles POST /api/v1/auth/deregister/cancel (requires
// Bearer access token): reverses the cool-down back to active (v2 §9.2).
func (h *AuthHandler) CancelDeregister(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}
	if err := h.authService.CancelDeregistration(c.Request.Context(), uid); err != nil {
		status, code := mapAuthError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deregistration cancelled"})
}

// ── helpers ────────────────────────────────────────────────────────────────

// userIDFromContext reads the user id injected by the AuthJWT middleware.
func userIDFromContext(c *gin.Context) (int64, bool) {
	uid, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return 0, false
	}
	id, ok := uid.(int64)
	if !ok {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return 0, false
	}
	return id, true
}

func toUserDTO(u *model.User) dto.UserDTO {
	out := dto.UserDTO{
		ID:        u.ID,
		Nickname:  u.Nickname,
		Role:      u.Role,
		CreatedAt: u.CreatedAt,
	}
	if u.Phone != nil {
		out.Phone = *u.Phone
	}
	if u.AvatarURL != nil {
		out.AvatarURL = *u.AvatarURL
	}
	return out
}

func authResponse(u *model.User, pair *service.TokenPair) dto.AuthResponse {
	return dto.AuthResponse{
		User:         toUserDTO(u),
		AccessToken:  pair.AccessToken,
		RefreshToken: pair.RefreshToken,
		TokenType:    pair.TokenType,
		ExpiresIn:    pair.ExpiresIn,
	}
}

// mapAuthError maps service sentinel errors to HTTP status + API code.
func mapAuthError(err error) (int, int) {
	switch {
	case errors.Is(err, service.ErrInvalidPhone),
		errors.Is(err, service.ErrWeakPassword),
		errors.Is(err, service.ErrTermsNotAgreed),
		errors.Is(err, service.ErrMissingCredential):
		return http.StatusBadRequest, 400
	case errors.Is(err, service.ErrCodeRateLimited):
		return http.StatusTooManyRequests, 429
	case errors.Is(err, service.ErrInvalidCode),
		errors.Is(err, service.ErrInvalidCredential),
		errors.Is(err, service.ErrTokenRevoked):
		return http.StatusUnauthorized, 401
	case errors.Is(err, service.ErrUserDisabled):
		return http.StatusForbidden, 403
	case errors.Is(err, service.ErrUserNotFound):
		return http.StatusNotFound, 404
	case errors.Is(err, service.ErrUserExists):
		return http.StatusConflict, 409
	default:
		return http.StatusInternalServerError, 500
	}
}
