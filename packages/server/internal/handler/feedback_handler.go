package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
	"gorm.io/gorm"
)

// FeedbackHandler serves user feedback submission (POST /api/v1/feedback)
// and the back-office feedback endpoints under /api/v1/admin (task #51, M6).
type FeedbackHandler struct {
	feedback *service.FeedbackService
}

// NewFeedbackHandler creates a new FeedbackHandler.
func NewFeedbackHandler(fs *service.FeedbackService) *FeedbackHandler {
	return &FeedbackHandler{feedback: fs}
}

// Create handles POST /api/v1/feedback (authenticated, writable-exempt).
func (h *FeedbackHandler) Create(c *gin.Context) {
	userID, ok := userIDFromContext(c)
	if !ok {
		return
	}
	var req dto.CreateFeedbackRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	id, err := h.feedback.Create(c.Request.Context(), userID, req)
	if err != nil {
		status, code := mapFeedbackError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "ok", Data: gin.H{"id": id}})
}

// List handles GET /api/v1/admin/feedbacks?status=&limit=50 (RequireAdmin).
func (h *FeedbackHandler) List(c *gin.Context) {
	status := c.Query("status")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	items, err := h.feedback.List(c.Request.Context(), status, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"items": items}})
}

// SetStatus handles POST /api/v1/admin/feedbacks/:id/status (RequireAdmin).
func (h *FeedbackHandler) SetStatus(c *gin.Context) {
	operatorID, ok := userIDFromContext(c)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid feedback id"})
		return
	}
	var req dto.SetFeedbackStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.feedback.SetStatus(c.Request.Context(), operatorID, id, req.Status); err != nil {
		status, code := mapFeedbackError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// mapFeedbackError maps service sentinel errors to HTTP status + API code.
func mapFeedbackError(err error) (int, int) {
	switch {
	case errors.Is(err, service.ErrFeedbackInvalidCategory),
		errors.Is(err, service.ErrFeedbackContentEmpty),
		errors.Is(err, service.ErrFeedbackContentTooLong),
		errors.Is(err, service.ErrFeedbackContactTooLong),
		errors.Is(err, service.ErrFeedbackInvalidStatus):
		return http.StatusBadRequest, 400
	case errors.Is(err, service.ErrFeedbackNotFound),
		errors.Is(err, gorm.ErrRecordNotFound):
		return http.StatusNotFound, 404
	default:
		return http.StatusInternalServerError, 500
	}
}
