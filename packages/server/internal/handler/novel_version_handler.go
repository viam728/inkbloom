package handler

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// NovelVersionHandler serves the Q3 whole-novel milestone snapshot endpoints
// (Agent safety work Q3): create / list / get / restore a point-in-time bundle
// of an entire novel.
type NovelVersionHandler struct {
	novelVersionService *service.NovelVersionService
}

// NewNovelVersionHandler creates a new NovelVersionHandler.
func NewNovelVersionHandler(s *service.NovelVersionService) *NovelVersionHandler {
	return &NovelVersionHandler{novelVersionService: s}
}

// bindOptional decodes an optional JSON body: an empty body is legitimate
// (both "checkpoint now" and "restore conservatively" need no payload), so
// only a malformed body is a 400.
func bindOptional(c *gin.Context, out interface{}) error {
	if err := c.ShouldBindJSON(out); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return err
	}
	return nil
}

// List handles GET /api/v1/novels/:id/versions
func (h *NovelVersionHandler) List(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	resp, err := h.novelVersionService.List(c.Request.Context(), GetUserID(c), novelID, limit, offset)
	if err != nil {
		// An unowned novel is reported as 404 rather than 403 so probes
		// cannot distinguish "exists but forbidden" from "absent".
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		zap.L().Error("list novel versions failed", zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

// Create handles POST /api/v1/novels/:id/versions
func (h *NovelVersionHandler) Create(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}

	var req dto.CreateNovelVersionRequest
	// The body is optional — an author may just want "checkpoint now".
	_ = c.ShouldBindJSON(&req)

	summary, err := h.novelVersionService.CreateMilestone(c.Request.Context(), GetUserID(c), novelID, req.Label)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrNotFound):
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
		case errors.Is(err, service.ErrInvalidInput):
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		default:
			zap.L().Error("create novel version failed", zap.Int64("novel_id", novelID), zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		}
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: summary})
}

// Get handles GET /api/v1/novels/:id/versions/:vid
func (h *NovelVersionHandler) Get(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	versionID, ok := parseID(c, "vid")
	if !ok {
		return
	}

	detail, err := h.novelVersionService.Get(c.Request.Context(), GetUserID(c), versionID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "version not found"})
			return
		}
		zap.L().Error("get novel version failed", zap.Int64("version_id", versionID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	// The service resolves ownership from the row; the path novel must agree
	// with it, otherwise /novels/2/versions/5 would serve a snapshot of 3.
	if detail != nil && detail.NovelID != novelID {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "version not found"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: detail})
}

// Restore handles POST /api/v1/novels/:id/versions/:vid/restore
func (h *NovelVersionHandler) Restore(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	versionID, ok := parseID(c, "vid")
	if !ok {
		return
	}

	var req dto.RestoreNovelVersionRequest
	// The body is optional: an absent or unrecognized mode degrades to the
	// safe conservative restore.
	_ = c.ShouldBindJSON(&req)

	result, err := h.novelVersionService.Restore(c.Request.Context(), GetUserID(c), novelID, versionID, req.Mode)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "version not found"})
			return
		}
		zap.L().Error("restore novel version failed",
			zap.Int64("novel_id", novelID), zap.Int64("version_id", versionID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: result})
}
