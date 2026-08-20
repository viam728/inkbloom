package handler

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/format"
)

// ExportHandler handles export/download HTTP requests.
type ExportHandler struct {
	chapterRepo repository.ChapterRepository
	novelRepo   repository.NovelRepository
	engine      *format.FormatEngine
}

// NewExportHandler creates a new ExportHandler.
func NewExportHandler(cr repository.ChapterRepository, nr repository.NovelRepository, engine *format.FormatEngine) *ExportHandler {
	return &ExportHandler{
		chapterRepo: cr,
		novelRepo:   nr,
		engine:      engine,
	}
}

// ExportChapter handles POST /api/v1/export/chapter/:id
func (h *ExportHandler) ExportChapter(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.ExportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	chapter, err := h.chapterRepo.GetByID(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if chapter == nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
		return
	}

	contentJSON := json.RawMessage(chapter.ContentJSON)
	if len(contentJSON) == 0 && chapter.Content != nil {
		// Wrap plain text content as a simple TipTap doc
		contentJSON = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":%q}]}]}`, *chapter.Content))
	}
	if len(contentJSON) == 0 {
		contentJSON = json.RawMessage(`{"type":"doc","content":[]}`)
	}

	content, err := h.engine.Convert(contentJSON, req.Format)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	renderer, _ := h.engine.GetRenderer(req.Format)
	filename := sanitizeFilename(chapter.Title) + extensionForFormat(req.Format)

	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, renderer.MimeType(), []byte(content))
}

// ExportNovel handles POST /api/v1/export/novel/:id
func (h *ExportHandler) ExportNovel(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.ExportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	novel, err := h.novelRepo.GetByID(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if novel == nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
		return
	}

	chapters, err := h.chapterRepo.ListByNovelID(c.Request.Context(), GetUserID(c), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	renderer, ok := h.engine.GetRenderer(req.Format)
	if !ok {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "unsupported format"})
		return
	}

	zipName := sanitizeFilename(novel.Title) + ".zip"
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", zipName))
	c.Header("Content-Type", "application/zip")

	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	for _, ch := range chapters {
		contentJSON := json.RawMessage(ch.ContentJSON)
		if len(contentJSON) == 0 && ch.Content != nil {
			contentJSON = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":%q}]}]}`, *ch.Content))
		}
		if len(contentJSON) == 0 {
			contentJSON = json.RawMessage(`{"type":"doc","content":[]}`)
		}

		content, err := h.engine.Convert(contentJSON, req.Format)
		if err != nil {
			continue // skip failed chapters
		}

		filename := fmt.Sprintf("%03d_%s%s", ch.Position, sanitizeFilename(ch.Title), extensionForFormat(req.Format))
		fw, err := zw.Create(filename)
		if err != nil {
			continue
		}
		fw.Write([]byte(content))
	}

	_ = renderer // renderer used for mimeType context
}

func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, ":", "_")
	name = strings.ReplaceAll(name, "\"", "_")
	name = strings.ReplaceAll(name, "*", "_")
	name = strings.ReplaceAll(name, "?", "_")
	name = strings.ReplaceAll(name, "<", "_")
	name = strings.ReplaceAll(name, ">", "_")
	name = strings.ReplaceAll(name, "|", "_")
	if name == "" {
		name = "untitled"
	}
	return name
}

func extensionForFormat(format string) string {
	switch format {
	case "markdown":
		return ".md"
	case "html", "wechat", "zhihu":
		return ".html"
	case "qidian":
		return ".txt"
	default:
		return ".txt"
	}
}
