package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// AdminHandler serves the back-office endpoints (/api/v1/admin/*, task #49,
// M5). The route group is guarded by AuthJWT + RequireAdmin.
type AdminHandler struct {
	adminService *service.AdminService
}

// NewAdminHandler creates a new AdminHandler.
func NewAdminHandler(as *service.AdminService) *AdminHandler {
	return &AdminHandler{adminService: as}
}

// Dashboard handles GET /api/v1/admin/dashboard.
func (h *AdminHandler) Dashboard(c *gin.Context) {
	data, err := h.adminService.Dashboard(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: data})
}

// ListUsers handles GET /api/v1/admin/users?search=&status=&page=&size=.
func (h *AdminHandler) ListUsers(c *gin.Context) {
	search := c.Query("search")
	status := c.Query("status")
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))

	data, err := h.adminService.ListUsers(c.Request.Context(), search, status, page, size)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: data})
}

// SetUserStatus handles POST /api/v1/admin/users/:id/status.
func (h *AdminHandler) SetUserStatus(c *gin.Context) {
	operatorID, ok := userIDFromContext(c)
	if !ok {
		return
	}
	targetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid user id"})
		return
	}
	var req dto.AdminSetStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.adminService.SetUserStatus(c.Request.Context(), operatorID, targetID, req.Status); err != nil {
		status, code := mapAdminError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// ExtendSubscription handles POST /api/v1/admin/subscriptions/:user_id/extend.
func (h *AdminHandler) ExtendSubscription(c *gin.Context) {
	operatorID, ok := userIDFromContext(c)
	if !ok {
		return
	}
	userID, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid user id"})
		return
	}
	var req dto.AdminExtendRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	sub, err := h.adminService.ExtendSubscription(c.Request.Context(), operatorID, userID, req.Days)
	if err != nil {
		status, code := mapAdminError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: gin.H{
			"expires_at":  sub.ExpiresAt,
			"grace_until": sub.GraceUntil,
		},
	})
}

// GrantTokens handles POST /api/v1/admin/token/grant.
func (h *AdminHandler) GrantTokens(c *gin.Context) {
	operatorID, ok := userIDFromContext(c)
	if !ok {
		return
	}
	var req dto.AdminTokenGrantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.adminService.GrantTokens(c.Request.Context(), operatorID, req.UserID, req.Amount, req.Note); err != nil {
		status, code := mapAdminError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// ListOrders handles GET /api/v1/admin/orders?kind=&limit=.
func (h *AdminHandler) ListOrders(c *gin.Context) {
	kind := c.Query("kind")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	items, err := h.adminService.ListOrders(c.Request.Context(), kind, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"items": items}})
}

// mapAdminError maps service sentinel errors to HTTP status + API code.
func mapAdminError(err error) (int, int) {
	switch {
	case errors.Is(err, service.ErrAdminTargetNotFound):
		return http.StatusNotFound, 404
	case errors.Is(err, service.ErrTokenInsufficient):
		return http.StatusPaymentRequired, 402
	default:
		return http.StatusInternalServerError, 500
	}
}
