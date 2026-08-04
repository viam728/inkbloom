package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service/format"
)

// FormatHandler handles format conversion HTTP requests.
type FormatHandler struct {
	engine *format.FormatEngine
}

// NewFormatHandler creates a new FormatHandler.
func NewFormatHandler(engine *format.FormatEngine) *FormatHandler {
	return &FormatHandler{engine: engine}
}

// Convert handles POST /api/v1/format/convert
func (h *FormatHandler) Convert(c *gin.Context) {
	var req dto.FormatConvertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	content, err := h.engine.Convert(req.ContentJSON, req.Format)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	renderer, _ := h.engine.GetRenderer(req.Format)
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: dto.FormatConvertResponse{
			Content:  content,
			Format:   req.Format,
			MimeType: renderer.MimeType(),
		},
	})
}

// Preview handles POST /api/v1/format/preview
func (h *FormatHandler) Preview(c *gin.Context) {
	var req dto.FormatPreviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	content, err := h.engine.Convert(req.ContentJSON, req.Format)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: dto.FormatPreviewResponse{
			HTML: content,
		},
	})
}

// Formats handles GET /api/v1/format/list
func (h *FormatHandler) Formats(c *gin.Context) {
	formats := h.engine.SupportedFormats()
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data:    formats,
	})
}
