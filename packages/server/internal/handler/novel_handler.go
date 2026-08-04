package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// NovelHandler handles novel HTTP requests.
type NovelHandler struct {
	novelService *service.NovelService
}

// NewNovelHandler creates a new NovelHandler.
func NewNovelHandler(ns *service.NovelService) *NovelHandler {
	return &NovelHandler{novelService: ns}
}

// CreateNovel handles POST /api/v1/novels
func (h *NovelHandler) CreateNovel(c *gin.Context) {
	var req dto.CreateNovelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	novel, err := h.novelService.CreateNovel(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: novel})
}

// GetNovel handles GET /api/v1/novels/:id
func (h *NovelHandler) GetNovel(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	novel, err := h.novelService.GetNovel(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: novel})
}

// ListNovels handles GET /api/v1/novels?page=1&page_size=20
func (h *NovelHandler) ListNovels(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))

	result, err := h.novelService.ListNovels(c.Request.Context(), page, pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: result})
}

// UpdateNovel handles PUT /api/v1/novels/:id
func (h *NovelHandler) UpdateNovel(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.UpdateNovelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	novel, err := h.novelService.UpdateNovel(c.Request.Context(), id, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: novel})
}

// DeleteNovel handles DELETE /api/v1/novels/:id
func (h *NovelHandler) DeleteNovel(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	if err := h.novelService.DeleteNovel(c.Request.Context(), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}
