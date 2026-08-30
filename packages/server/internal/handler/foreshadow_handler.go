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

// ForeshadowHandler serves the E2 foreshadow tracking endpoints
// (business plan v3, construction plan A12).
type ForeshadowHandler struct {
	fs *service.ForeshadowService
}

// NewForeshadowHandler creates a new ForeshadowHandler.
func NewForeshadowHandler(fs *service.ForeshadowService) *ForeshadowHandler {
	return &ForeshadowHandler{fs: fs}
}

// parseForeshadowID reads the :fid path param.
func parseForeshadowID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("fid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid fid"})
		return 0, false
	}
	return id, true
}

// List handles GET /api/v1/novels/:id/foreshadows
func (h *ForeshadowHandler) List(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	list, err := h.fs.List(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		zap.L().Error("list foreshadows failed", zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if list == nil {
		list = []dto.ForeshadowResponse{}
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: list})
}

// ListPending handles GET /api/v1/novels/:id/foreshadows/pending
// Hints handles GET /api/v1/novels/:id/foreshadows/hints?chapter_id=X
func (h *ForeshadowHandler) Hints(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	chapterID, err := strconv.ParseInt(c.Query("chapter_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "chapter_id is required"})
		return
	}
	resp, err := h.fs.Hints(c.Request.Context(), GetUserID(c), novelID, chapterID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel or chapter not found"})
			return
		}
		zap.L().Error("foreshadow hints failed", zap.Int64("chapter_id", chapterID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

func (h *ForeshadowHandler) ListPending(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	list, err := h.fs.ListPending(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		zap.L().Error("list pending foreshadows failed", zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if list == nil {
		list = []dto.ForeshadowResponse{}
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: list})
}

// Create handles POST /api/v1/novels/:id/foreshadows
func (h *ForeshadowHandler) Create(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	var req dto.CreateForeshadowRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	created, err := h.fs.Create(c.Request.Context(), GetUserID(c), novelID, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		zap.L().Error("create foreshadow failed", zap.Int64("novel_id", novelID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: created})
}

// UpdateStatus handles PUT /api/v1/foreshadows/:fid
func (h *ForeshadowHandler) UpdateStatus(c *gin.Context) {
	fid, ok := parseForeshadowID(c)
	if !ok {
		return
	}
	var req dto.UpdateForeshadowStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	updated, err := h.fs.UpdateStatus(c.Request.Context(), GetUserID(c), fid, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "foreshadow not found"})
			return
		}
		zap.L().Error("update foreshadow failed", zap.Int64("fid", fid), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: updated})
}

// Delete handles DELETE /api/v1/foreshadows/:fid
func (h *ForeshadowHandler) Delete(c *gin.Context) {
	fid, ok := parseForeshadowID(c)
	if !ok {
		return
	}
	if err := h.fs.Delete(c.Request.Context(), GetUserID(c), fid); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "foreshadow not found"})
			return
		}
		zap.L().Error("delete foreshadow failed", zap.Int64("fid", fid), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// DetectPlants handles POST /api/v1/novels/:id/foreshadows/detect
func (h *ForeshadowHandler) DetectPlants(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	var req struct {
		ChapterID int64 `json:"chapter_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	resp, err := h.fs.DetectPlants(c.Request.Context(), GetUserID(c), novelID, req.ChapterID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		zap.L().Error("detect foreshadows failed", zap.Int64("chapter_id", req.ChapterID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

// ScanChapter handles POST /api/v1/novels/:id/foreshadows/scan
func (h *ForeshadowHandler) ScanChapter(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	var req struct {
		ChapterID int64 `json:"chapter_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	resp, err := h.fs.ScanChapter(c.Request.Context(), GetUserID(c), novelID, req.ChapterID)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		zap.L().Error("scan foreshadows failed", zap.Int64("chapter_id", req.ChapterID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}
