package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// HistoryHandler serves the E1 chapter version history endpoints
// (business plan v3, construction plan A05).
type HistoryHandler struct {
	historyService *service.HistoryService
}

// NewHistoryHandler creates a new HistoryHandler.
func NewHistoryHandler(hs *service.HistoryService) *HistoryHandler {
	return &HistoryHandler{historyService: hs}
}

// parseID reads a positive int64 path param, writing 400 and reporting false
// when the value is malformed.
func parseID(c *gin.Context, name string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid " + name})
		return 0, false
	}
	return id, true
}

// ListVersions handles GET /api/v1/chapters/:id/versions
func (h *HistoryHandler) ListVersions(c *gin.Context) {
	chapterID, ok := parseID(c, "id")
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	resp, err := h.historyService.ListVersions(c.Request.Context(), GetUserID(c), chapterID, limit, offset)
	if err != nil {
		// An unowned chapter is reported as 404 rather than 403 so probes
		// cannot distinguish "exists but forbidden" from "absent".
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		zap.L().Error("list chapter versions failed", zap.Int64("chapter_id", chapterID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

// GetVersion handles GET /api/v1/chapters/:id/versions/:vid
func (h *HistoryHandler) GetVersion(c *gin.Context) {
	chapterID, ok := parseID(c, "id")
	if !ok {
		return
	}
	versionID, ok := parseID(c, "vid")
	if !ok {
		return
	}

	detail, err := h.historyService.GetVersion(c.Request.Context(), GetUserID(c), chapterID, versionID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "version not found"})
			return
		}
		zap.L().Error("get chapter version failed", zap.Int64("version_id", versionID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: detail})
}

// CreateSnapshot handles POST /api/v1/chapters/:id/versions
func (h *HistoryHandler) CreateSnapshot(c *gin.Context) {
	chapterID, ok := parseID(c, "id")
	if !ok {
		return
	}

	var req dto.CreateVersionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	summary, err := h.historyService.CreateSnapshot(c.Request.Context(), GetUserID(c), chapterID, &req)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrNotFound):
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
		case errors.Is(err, service.ErrInvalidVersionKind):
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		default:
			zap.L().Error("create chapter version failed", zap.Int64("chapter_id", chapterID), zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		}
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: summary})
}

// RestoreVersion handles POST /api/v1/chapters/:id/versions/:vid/restore
func (h *HistoryHandler) RestoreVersion(c *gin.Context) {
	chapterID, ok := parseID(c, "id")
	if !ok {
		return
	}
	versionID, ok := parseID(c, "vid")
	if !ok {
		return
	}

	checkpoint, err := h.historyService.RestoreVersion(c.Request.Context(), GetUserID(c), chapterID, versionID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "version not found"})
			return
		}
		zap.L().Error("restore chapter version failed",
			zap.Int64("chapter_id", chapterID), zap.Int64("version_id", versionID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: checkpoint})
}
