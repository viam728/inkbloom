package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// KnowledgeHandler handles knowledge graph HTTP requests.
type KnowledgeHandler struct {
	knowledgeService *service.KnowledgeService
}

// NewKnowledgeHandler creates a new KnowledgeHandler.
func NewKnowledgeHandler(ks *service.KnowledgeService) *KnowledgeHandler {
	return &KnowledgeHandler{knowledgeService: ks}
}

// Extract handles POST /api/v1/knowledge/extract — extract entities and relations from text.
func (h *KnowledgeHandler) Extract(c *gin.Context) {
	var req dto.ExtractRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	if err := h.knowledgeService.ExtractFromChapter(c.Request.Context(), req.NovelID, req.ChapterID, req.Text); err != nil {
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "extraction completed"})
}

// GetGraph handles GET /api/v1/knowledge/graph/:novel_id — get knowledge graph data.
func (h *KnowledgeHandler) GetGraph(c *gin.Context) {
	novelID, err := strconv.ParseInt(c.Param("novel_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel_id"})
		return
	}

	graph, err := h.knowledgeService.GetGraph(c.Request.Context(), novelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: graph})
}

// CheckConsistency handles POST /api/v1/knowledge/check — check text consistency.
func (h *KnowledgeHandler) CheckConsistency(c *gin.Context) {
	var req dto.ConsistencyCheckRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	issues, err := h.knowledgeService.CheckConsistency(c.Request.Context(), req.NovelID, req.ChapterID, req.Text)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: issues})
}
