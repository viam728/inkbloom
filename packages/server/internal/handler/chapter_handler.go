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

// ChapterHandler handles chapter HTTP requests.
type ChapterHandler struct {
	chapterService *service.ChapterService
}

// NewChapterHandler creates a new ChapterHandler.
func NewChapterHandler(cs *service.ChapterService) *ChapterHandler {
	return &ChapterHandler{chapterService: cs}
}

// CreateChapter handles POST /api/v1/chapters
func (h *ChapterHandler) CreateChapter(c *gin.Context) {
	var req dto.CreateChapterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	chapter, err := h.chapterService.CreateChapter(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: chapter})
}

// GetChapter handles GET /api/v1/chapters/:id
func (h *ChapterHandler) GetChapter(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	chapter, err := h.chapterService.GetChapter(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: chapter})
}

// GetChapterContent handles GET /api/v1/chapters/:id/content
func (h *ChapterHandler) GetChapterContent(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	chapter, err := h.chapterService.GetChapter(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: gin.H{
			"id":           chapter.ID,
			"title":        chapter.Title,
			"content":      chapter.Content,
			"content_json": chapter.ContentJSON,
		},
	})
}

// ReorderChapters handles PUT /api/v1/novels/:id/chapters/order
func (h *ChapterHandler) ReorderChapters(c *gin.Context) {
	novelID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return
	}

	var req dto.ReorderChaptersRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.chapterService.ReorderChapters(c.Request.Context(), GetUserID(c), novelID, req.OrderedIDs); err != nil {
		switch {
		case errors.Is(err, service.ErrNotFound):
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
		case errors.Is(err, service.ErrInvalidInput), errors.Is(err, repository.ErrReorderIDMismatch):
			zap.L().Warn("reorder chapters rejected", zap.Int64("novel_id", novelID), zap.Error(err))
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		default:
			zap.L().Error("reorder chapters failed", zap.Int64("novel_id", novelID), zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// ListChaptersByNovel handles GET /api/v1/novels/:id/chapters
func (h *ChapterHandler) ListChaptersByNovel(c *gin.Context) {
	novelID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return
	}

	chapters, err := h.chapterService.ListChaptersByNovel(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: chapters})
}

// UpdateChapter handles PUT /api/v1/chapters/:id
func (h *ChapterHandler) UpdateChapter(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.UpdateChapterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	chapter, err := h.chapterService.UpdateChapter(c.Request.Context(), GetUserID(c), id, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: chapter})
}

// DeleteChapter handles DELETE /api/v1/chapters/:id
func (h *ChapterHandler) DeleteChapter(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	if err := h.chapterService.DeleteChapter(c.Request.Context(), GetUserID(c), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}
