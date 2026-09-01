package handler

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/signedurl"
	"github.com/inkbloom/server/internal/service"
)

const (
	// imageUploadMaxBytes caps gallery uploads at 20MB (task #57).
	imageUploadMaxBytes = 20 << 20
	// imageUploadOverhead is multipart framing slack on top of the body cap.
	imageUploadOverhead = 1 << 20
	// imageListDefaultLimit / imageListMaxLimit bound keyset page sizes.
	imageListDefaultLimit = 60
	imageListMaxLimit     = 200
	// imageBatchDeleteMax caps ids per batch request.
	imageBatchDeleteMax = 500
)

// mimeByExtension maps an allowed upload extension to its storage ext.
var imageExtByMIME = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

// ImageHandler serves the frozen /api/v1/images contract (task #57).
type ImageHandler struct {
	svc *service.ImageService
}

// NewImageHandler creates a new ImageHandler.
func NewImageHandler(svc *service.ImageService) *ImageHandler {
	return &ImageHandler{svc: svc}
}

// Upload handles POST /api/v1/images — multipart field "file" plus form
// fields scope (novel|media|memo, invalid falls back to novel) and the
// optional novel_id. Answers 201 with dto.ImageUploadResult.
func (h *ImageHandler) Upload(c *gin.Context) {
	userID, ok := userIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}

	// Enforce the 20MB body cap at the transport level.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, imageUploadMaxBytes+imageUploadOverhead)

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "文件超过 20MB 限制"})
			return
		}
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "缺少 multipart 字段 \"file\""})
		return
	}
	defer file.Close()

	if header.Size <= 0 || header.Size > imageUploadMaxBytes {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "文件超过 20MB 限制"})
		return
	}

	ext := filepathExt(header.Filename)
	if !portraitExtensions[ext] {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "不支持的文件扩展名；允许: jpg, jpeg, png, webp, gif"})
		return
	}

	scopeVal := normalizeScope(c.PostForm("scope"))
	var novelID int64
	if v := c.PostForm("novel_id"); v != "" {
		if parsed, perr := strconv.ParseInt(v, 10, 64); perr == nil && parsed > 0 {
			novelID = parsed
		}
	}

	// Peek the first 512 bytes for MIME sniffing, then reassemble the stream
	// so Ingest still sees every byte exactly once.
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	mime := strings.ToLower(strings.SplitN(http.DetectContentType(head[:n]), ";", 2)[0])
	storedExt, mimeOK := imageExtByMIME[mime]
	if !mimeOK || !portraitMIMETypes[mime] {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "不支持的内容类型；允许: image/jpeg, image/png, image/webp, image/gif"})
		return
	}

	stream := io.MultiReader(bytes.NewReader(head[:n]), file)
	asset, deduplicated, err := h.svc.Ingest(c.Request.Context(), stream, service.IngestMeta{
		UserID:    userID,
		Scope:     scopeVal,
		NovelID:   novelID,
		Source:    model.AssetSourceUpload,
		Extension: storedExt,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "图片入库失败: " + err.Error()})
		return
	}

	c.JSON(http.StatusCreated, dto.APIResponse{
		Code:    201,
		Message: "ok",
		Data: dto.ImageUploadResult{
			ID:           asset.ID,
			URL:          signedurl.SignURL(GetUserID(c), asset.FilePath),
			ThumbURL:     signedurl.SignURL(GetUserID(c), asset.ThumbnailPath),
			ContentHash:  asset.ContentHash,
			DisplayName:  asset.DisplayName,
			Width:        int(asset.Width),
			Height:       int(asset.Height),
			Size:         int64(asset.FileSize),
			Scope:        asset.Scope,
			Source:       asset.Source,
			Deduplicated: deduplicated,
		},
	})
}

// List handles GET /api/v1/images?scope=&novel_id=&limit=&cursor=.
func (h *ImageHandler) List(c *gin.Context) {
	userID, ok := userIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}

	scopeVal := c.Query("scope")
	if scopeVal != "" {
		scopeVal = normalizeScope(scopeVal)
	}
	var novelID *int64
	if v := c.Query("novel_id"); v != "" {
		if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 {
			novelID = &parsed
		}
	}
	limit := imageListDefaultLimit
	if v := c.Query("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > imageListMaxLimit {
		limit = imageListMaxLimit
	}

	assets, nextCursor, err := h.svc.List(c.Request.Context(), userID, scopeVal, novelID, limit, c.Query("cursor"))
	if err != nil {
		if errors.Is(err, service.ErrImageCursorFormat) {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "无效的 cursor"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "列表查询失败"})
		return
	}

	items := make([]dto.ImageItem, 0, len(assets))
	for i := range assets {
		a := &assets[i]
		items = append(items, dto.ImageItem{
			ID:          a.ID,
			URL:         a.FilePath,
			ThumbURL:    a.ThumbnailPath,
			ContentHash: a.ContentHash,
			DisplayName: a.DisplayName,
			Width:       a.Width,
			Height:      a.Height,
			FileSize:    a.FileSize,
			Scope:       a.Scope,
			Source:      a.Source,
			NovelID:     a.NovelID,
			CreatedAt:   a.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data:    dto.ImageListResult{Items: items, NextCursor: nextCursor},
	})
}

// Delete handles DELETE /api/v1/images/:id?force=true|false. Images still
// referenced by prose answer 409 unless force is set.
func (h *ImageHandler) Delete(c *gin.Context) {
	userID, ok := userIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}
	force := strings.EqualFold(c.Query("force"), "true")

	if err := h.svc.Delete(c.Request.Context(), userID, id, force); err != nil {
		switch {
		case errors.Is(err, service.ErrImageNotFound):
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "图片不存在"})
		case errors.Is(err, service.ErrImageReferenced):
			c.JSON(http.StatusConflict, dto.APIResponse{Code: 409, Message: "图片仍被内容引用"})
		default:
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "删除失败"})
		}
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{"id": id}})
}

// BatchDelete handles POST /api/v1/images/batch-delete with body {ids}.
func (h *ImageHandler) BatchDelete(c *gin.Context) {
	userID, ok := userIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}
	var req dto.ImageBatchDeleteRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "ids 不能为空"})
		return
	}
	if len(req.IDs) > imageBatchDeleteMax {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "单次最多删除 500 张"})
		return
	}
	deleted, skipped, err := h.svc.BatchDelete(c.Request.Context(), userID, req.IDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "批量删除失败"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data:    dto.ImageBatchDeleteResult{Deleted: deleted, Skipped: skipped},
	})
}

// normalizeScope maps any unknown/missing scope to the novel default.
func normalizeScope(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case model.AssetScopeMedia:
		return model.AssetScopeMedia
	case model.AssetScopeMemo:
		return model.AssetScopeMemo
	default:
		return model.AssetScopeNovel
	}
}

// filepathExt returns the lowercase file extension including the dot.
func filepathExt(name string) string {
	idx := strings.LastIndexByte(name, '.')
	if idx < 0 {
		return ""
	}
	return strings.ToLower(name[idx:])
}
