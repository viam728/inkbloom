package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// StoryHandler exposes the Agent full-book creation pipeline endpoints.
type StoryHandler struct {
	storySvc *service.StoryService
}

// NewStoryHandler creates a new StoryHandler.
func NewStoryHandler(svc *service.StoryService) *StoryHandler {
	return &StoryHandler{storySvc: svc}
}

// Create handles POST /api/v1/ai/story/jobs.
func (h *StoryHandler) Create(c *gin.Context) {
	var req dto.CreateStoryJobRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid request: " + err.Error()})
		return
	}
	job, err := h.storySvc.CreateJob(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to create job"})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}

// Get handles GET /api/v1/ai/story/jobs/:id.
func (h *StoryHandler) Get(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	job, err := h.storySvc.Get(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to get job"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}

// List handles GET /api/v1/ai/story/jobs.
func (h *StoryHandler) List(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	novelID, _ := strconv.ParseInt(c.Query("novel_id"), 10, 64)
	res, err := h.storySvc.List(c.Request.Context(), GetUserID(c), novelID, page, pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to list jobs"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: res})
}

// Delete handles DELETE /api/v1/ai/story/jobs/:id.
func (h *StoryHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if err := h.storySvc.Delete(c.Request.Context(), GetUserID(c), id); err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to delete job"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// GenerateStage handles POST /api/v1/ai/story/jobs/:id/generate.
func (h *StoryHandler) GenerateStage(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var req dto.GenerateStageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		req = dto.GenerateStageRequest{}
	}
	job, err := h.storySvc.GenerateStage(c.Request.Context(), GetUserID(c), id, req.Instruction)
	if err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusBadGateway, dto.APIResponse{Code: 502, Message: "AI stage failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}

// AdoptChapter handles POST /api/v1/ai/story/jobs/:id/chapters/adopt.
func (h *StoryHandler) AdoptChapter(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var req dto.AdoptChapterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid request: " + err.Error()})
		return
	}
	job, err := h.storySvc.AdoptChapter(c.Request.Context(), GetUserID(c), id, &req)
	if err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to adopt chapter"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}

// AdvanceStage handles POST /api/v1/ai/story/jobs/:id/advance.
func (h *StoryHandler) AdvanceStage(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	job, err := h.storySvc.AdvanceStage(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to advance job"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}

// SetStage handles POST /api/v1/ai/story/jobs/:id/stage — direct stage jump
// (sliding selector, no linear order enforced).
func (h *StoryHandler) SetStage(c *gin.Context) {
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var req dto.SetStageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid request: " + err.Error()})
		return
	}
	job, err := h.storySvc.SetStage(c.Request.Context(), GetUserID(c), id, req.Stage)
	if err != nil {
		if errors.Is(err, service.ErrStoryJobNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "job not found"})
			return
		}
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: job})
}
