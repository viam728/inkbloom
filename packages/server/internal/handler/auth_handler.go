package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

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

	user, pair, err := h.authService.Register(c.Request.Context(), req.Phone, req.Code, req.Password, req.Nickname, req.AgreedTerms, deviceInfoFromRequest(c))
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

	user, pair, err := h.authService.Login(c.Request.Context(), req.Phone, req.Password, req.Code, deviceInfoFromRequest(c))
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

	user, pair, err := h.authService.Refresh(c.Request.Context(), req.RefreshToken, deviceInfoFromRequest(c))
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

// ListSessions handles GET /api/v1/auth/sessions (device management, plan A22).
func (h *AuthHandler) ListSessions(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}
	list, err := h.authService.ListSessions(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	out := make([]dto.UserSessionDTO, 0, len(list))
	for i := range list {
		out = append(out, toSessionDTO(&list[i]))
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.SessionsResponse{Sessions: out}})
}

// DeleteSession handles DELETE /api/v1/auth/sessions/:id (plan A22).
func (h *AuthHandler) DeleteSession(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid session id"})
		return
	}
	if err := h.authService.DeleteSession(c.Request.Context(), uid, id); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "session revoked"})
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

func toSessionDTO(s *model.UserSession) dto.UserSessionDTO {
	return dto.UserSessionDTO{
		ID:           s.ID,
		DeviceName:   s.DeviceName,
		DeviceType:   s.DeviceType,
		IP:           s.IP,
		LastActiveAt: s.LastActiveAt,
		CreatedAt:    s.CreatedAt,
		ExpiresAt:    s.ExpiresAt,
	}
}

// deviceInfoFromRequest derives session metadata from the request. The
// desktop app is recognised by its Electron User-Agent; mobile by common
// mobile tokens; everything else counts as web.
func deviceInfoFromRequest(c *gin.Context) service.DeviceInfo {
	ua := c.Request.UserAgent()
	lower := strings.ToLower(ua)
	info := service.DeviceInfo{
		DeviceName: deviceNameFromUA(ua),
		IP:         c.ClientIP(),
	}
	switch {
	case strings.Contains(lower, "electron") || strings.Contains(lower, "inkbloom-desktop"):
		info.DeviceType = model.DeviceDesktop
	case strings.Contains(lower, "mobile") || strings.Contains(lower, "android") ||
		strings.Contains(lower, "iphone") || strings.Contains(lower, "ipad"):
		info.DeviceType = model.DeviceMobile
	default:
		info.DeviceType = model.DeviceWeb
	}
	if info.DeviceName == "" {
		info.DeviceName = "未知设备"
	}
	return info
}

// deviceNameFromUA extracts a short human-readable device label from a
// User-Agent string, falling back to the raw string when unrecognised.
func deviceNameFromUA(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case strings.Contains(lower, "electron") || strings.Contains(lower, "inkbloom-desktop"):
		return "桌面客户端"
	case strings.Contains(lower, "edg"):
		return "Edge 浏览器"
	case strings.Contains(lower, "chrome"):
		return "Chrome 浏览器"
	case strings.Contains(lower, "firefox"):
		return "Firefox 浏览器"
	case strings.Contains(lower, "safari"):
		return "Safari 浏览器"
	case strings.Contains(lower, "wechat") || strings.Contains(lower, "micromessenger"):
		return "微信"
	default:
		if len(ua) > 60 {
			return ua[:60]
		}
		return ua
	}
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
