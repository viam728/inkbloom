package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// updateOutlineRequest is the PUT /novels/:id/outline body (whole-document
// replacement). Version is an optional optimistic-concurrency hint.
type updateOutlineRequest struct {
	Acts    json.RawMessage `json:"acts"`
	Version *int            `json:"version"`
}

// updateMemoryRequest is the PUT /novels/:id/memory body.
type updateMemoryRequest struct {
	Items   json.RawMessage `json:"items"`
	Version *int            `json:"version"`
}

// NovelDocHandler handles outline / memory / rhythm HTTP requests.
type NovelDocHandler struct {
	docService *service.NovelDocService
}

// NewNovelDocHandler creates a new NovelDocHandler.
func NewNovelDocHandler(ds *service.NovelDocService) *NovelDocHandler {
	return &NovelDocHandler{docService: ds}
}

// GetOutline handles GET /api/v1/novels/:id/outline
// Response data: { acts: OutlineAct[], version: number }
func (h *NovelDocHandler) GetOutline(c *gin.Context) {
	novelID, ok := h.parseNovelID(c)
	if !ok {
		return
	}

	doc, err := h.docService.GetOutline(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		h.writeError(c, "get outline failed", novelID, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: doc})
}

// UpdateOutline handles PUT /api/v1/novels/:id/outline
// Request body: { acts: OutlineAct[], version?: number } (whole replacement).
func (h *NovelDocHandler) UpdateOutline(c *gin.Context) {
	novelID, ok := h.parseNovelID(c)
	if !ok {
		return
	}

	var req updateOutlineRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	version, err := h.docService.UpdateOutline(c.Request.Context(), GetUserID(c), novelID, req.Acts, req.Version)
	if err != nil {
		h.writeError(c, "update outline failed", novelID, err)
		return
	}
	// 备忘录 L57/59: after a committed web-panel outline save, enforce the
	// outline↔chapter invariants (drop phantom / duplicate bindings, one chapter
	// per node) and resync chapters.position to the outline order. Best-effort:
	// a sync failure must not fail the save the user already committed.
	if serr := h.docService.SyncOutlineChapterOrder(c.Request.Context(), GetUserID(c), novelID); serr != nil {
		zap.L().Warn("outline chapter-order sync failed",
			zap.Int64("novel_id", novelID), zap.Error(serr))
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"version": version}})
}

// GetMemory handles GET /api/v1/novels/:id/memory
// Response data: { items: MemoryItem[], version: number }
func (h *NovelDocHandler) GetMemory(c *gin.Context) {
	novelID, ok := h.parseNovelID(c)
	if !ok {
		return
	}

	doc, err := h.docService.GetMemory(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		h.writeError(c, "get memory failed", novelID, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: doc})
}

// UpdateMemory handles PUT /api/v1/novels/:id/memory
// Request body: { items: MemoryItem[], version?: number } (whole replacement).
func (h *NovelDocHandler) UpdateMemory(c *gin.Context) {
	novelID, ok := h.parseNovelID(c)
	if !ok {
		return
	}

	var req updateMemoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	version, err := h.docService.UpdateMemory(c.Request.Context(), GetUserID(c), novelID, req.Items, req.Version)
	if err != nil {
		h.writeError(c, "update memory failed", novelID, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"version": version}})
}

// GetRhythm handles GET /api/v1/novels/:id/rhythm
// Response data: { points: [{ chapter_id: number, score: number }] }
func (h *NovelDocHandler) GetRhythm(c *gin.Context) {
	novelID, ok := h.parseNovelID(c)
	if !ok {
		return
	}

	points, err := h.docService.GetRhythm(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		h.writeError(c, "get rhythm failed", novelID, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"points": points}})
}

// parseNovelID extracts and validates the :id path parameter.
func (h *NovelDocHandler) parseNovelID(c *gin.Context) (int64, bool) {
	novelID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return 0, false
	}
	return novelID, true
}

// writeError maps service errors onto the unified envelope:
// 404 not found / 409 version conflict / 422 semantic rejection / 500 internal.
func (h *NovelDocHandler) writeError(c *gin.Context, op string, novelID int64, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
	case errors.Is(err, service.ErrVersionConflict):
		zap.L().Warn(op+": version conflict", zap.Int64("novel_id", novelID))
		c.JSON(http.StatusConflict, dto.APIResponse{Code: 409, Message: err.Error()})
	case errors.Is(err, service.ErrPayloadTooLarge), errors.Is(err, service.ErrInvalidInput):
		zap.L().Warn(op+": rejected", zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
	default:
		zap.L().Error(op, zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
	}
}
