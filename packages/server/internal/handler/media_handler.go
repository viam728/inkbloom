package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// MediaHandler handles self-media content & topic HTTP requests.
//
// Route registration note (Gin): the static segment PUT /media/contents/order
// and the wildcard PUT /media/contents/:id coexist — Gin resolves static
// siblings ahead of params. Register the static route BEFORE the wildcard
// route to keep intent explicit.
type MediaHandler struct {
	mediaService *service.MediaService
}

// NewMediaHandler creates a new MediaHandler.
func NewMediaHandler(ms *service.MediaService) *MediaHandler {
	return &MediaHandler{mediaService: ms}
}

// ListContents handles GET /media/contents
// Response data: { contents: MediaContent[] }
func (h *MediaHandler) ListContents(c *gin.Context) {
	contents, err := h.mediaService.ListContents(c.Request.Context(), GetUserID(c))
	if err != nil {
		zap.L().Error("list media contents failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"contents": contents}})
}

// CreateContent handles POST /media/contents
func (h *MediaHandler) CreateContent(c *gin.Context) {
	var req dto.CreateMediaContentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	content, err := h.mediaService.CreateContent(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		zap.L().Error("create media content failed", zap.String("title", req.Title), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: content})
}

// UpdateContent handles PUT /media/contents/:id
func (h *MediaHandler) UpdateContent(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.UpdateMediaContentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	content, err := h.mediaService.UpdateContent(c.Request.Context(), GetUserID(c), id, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "media content not found"})
			return
		}
		zap.L().Error("update media content failed", zap.Int64("id", id), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: content})
}

// DeleteContent handles DELETE /media/contents/:id (soft delete)
func (h *MediaHandler) DeleteContent(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	if err := h.mediaService.DeleteContent(c.Request.Context(), GetUserID(c), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "media content not found"})
			return
		}
		zap.L().Error("delete media content failed", zap.Int64("id", id), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}

// ReorderContents handles PUT /media/contents/order
// Request body: { ordered_ids: number[] } — full id list in desired order;
// positions are rewritten to 0..n-1 (idempotent).
func (h *MediaHandler) ReorderContents(c *gin.Context) {
	var req dto.ReorderMediaContentsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.mediaService.ReorderContents(c.Request.Context(), GetUserID(c), req.OrderedIDs); err != nil {
		switch {
		case errors.Is(err, service.ErrInvalidInput), errors.Is(err, repository.ErrMediaReorderIDMismatch):
			zap.L().Warn("reorder media contents rejected", zap.Error(err))
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		default:
			zap.L().Error("reorder media contents failed", zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// ListTopics handles GET /media/topics
// Response data: { topics: TopicItem[] }
func (h *MediaHandler) ListTopics(c *gin.Context) {
	topics, err := h.mediaService.ListTopics(c.Request.Context(), GetUserID(c))
	if err != nil {
		zap.L().Error("list media topics failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"topics": topics}})
}

// SaveTopics handles POST /media/topics
// Request body: { topics: TopicItem[] } — full replacement (DELETE all +
// bulk INSERT inside one transaction, idempotent).
func (h *MediaHandler) SaveTopics(c *gin.Context) {
	var req dto.SaveTopicsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	topics, err := h.mediaService.SaveTopics(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		zap.L().Error("save media topics failed", zap.Int("count", len(req.Topics)), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"topics": topics}})
}

// GetMediaMemory handles GET /media/memory
// Response data: { items: MemoryItem[], version: number }
func (h *MediaHandler) GetMediaMemory(c *gin.Context) {
	doc, err := h.mediaService.GetMediaMemory(c.Request.Context(), GetUserID(c))
	if err != nil {
		zap.L().Error("get media memory failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: doc})
}

// UpdateMediaMemory handles PUT /media/memory
// Request body: { items: MemoryItem[], version?: number } (whole replacement).
// Error mapping: 409 version conflict / 422 payload rejected / 500 internal.
func (h *MediaHandler) UpdateMediaMemory(c *gin.Context) {
	var req dto.UpdateMediaMemoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	doc, err := h.mediaService.UpdateMediaMemory(c.Request.Context(), GetUserID(c), req.Items, req.Version)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrVersionConflict):
			zap.L().Warn("update media memory: version conflict")
			c.JSON(http.StatusConflict, dto.APIResponse{Code: 409, Message: err.Error()})
		case errors.Is(err, service.ErrPayloadTooLarge), errors.Is(err, service.ErrInvalidInput):
			zap.L().Warn("update media memory: rejected", zap.Error(err))
			c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		default:
			zap.L().Error("update media memory failed", zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: doc})
}
