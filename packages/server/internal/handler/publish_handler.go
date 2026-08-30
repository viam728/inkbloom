package handler

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// PublishHandler serves the E4 author-facing publishing endpoints (plan A17).
type PublishHandler struct {
	ps *service.PublishService
}

// NewPublishHandler creates a new PublishHandler.
func NewPublishHandler(ps *service.PublishService) *PublishHandler {
	return &PublishHandler{ps: ps}
}

// ListMyWorks handles GET /api/v1/publish/works
func (h *PublishHandler) ListMyWorks(c *gin.Context) {
	list, err := h.ps.ListMyWorks(c.Request.Context(), GetUserID(c))
	if err != nil {
		zap.L().Error("list published works failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if list == nil {
		list = []dto.WorkResponse{}
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: list})
}

// CreateWork handles POST /api/v1/publish/works
func (h *PublishHandler) CreateWork(c *gin.Context) {
	var req dto.CreateWorkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	w, err := h.ps.CreateWork(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		h.respondPublishError(c, err)
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: w})
}

// UpdateWork handles PUT /api/v1/publish/works/:wid
func (h *PublishHandler) UpdateWork(c *gin.Context) {
	wid, ok := parseID(c, "wid")
	if !ok {
		return
	}
	var req dto.UpdateWorkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	w, err := h.ps.UpdateWork(c.Request.Context(), GetUserID(c), wid, &req)
	if err != nil {
		h.respondPublishError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: w})
}

// Unpublish handles DELETE /api/v1/publish/works/:wid
func (h *PublishHandler) Unpublish(c *gin.Context) {
	wid, ok := parseID(c, "wid")
	if !ok {
		return
	}
	if err := h.ps.Unpublish(c.Request.Context(), GetUserID(c), wid); err != nil {
		h.respondPublishError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// PublishChapter handles POST /api/v1/publish/works/:wid/chapters
func (h *PublishHandler) PublishChapter(c *gin.Context) {
	wid, ok := parseID(c, "wid")
	if !ok {
		return
	}
	var req dto.PublishChapterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	pc, err := h.ps.PublishChapter(c.Request.Context(), GetUserID(c), wid, &req)
	if err != nil {
		h.respondPublishError(c, err)
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: pc})
}

// UnpublishChapter handles DELETE /api/v1/publish/chapters/:pid
func (h *PublishHandler) UnpublishChapter(c *gin.Context) {
	pid, err := strconv.ParseInt(c.Param("pid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid pid"})
		return
	}
	if err := h.ps.UnpublishChapter(c.Request.Context(), GetUserID(c), pid); err != nil {
		h.respondPublishError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// respondPublishError maps domain errors to HTTP status codes.
func (h *PublishHandler) respondPublishError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "not found"})
	case errors.Is(err, service.ErrAlreadyPublished):
		c.JSON(http.StatusConflict, dto.APIResponse{Code: 409, Message: "该作品已发布，请直接编辑"})
	case errors.Is(err, service.ErrInvalidSlug):
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "slug 格式不合法（仅小写字母数字与连字符，3–120 字符）"})
	case errors.Is(err, service.ErrSlugTaken):
		c.JSON(http.StatusConflict, dto.APIResponse{Code: 409, Message: "slug 已被占用"})
	case errors.Is(err, contentsafety.ErrContentRejected):
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: "内容未通过安全审核，无法发布"})
	default:
		zap.L().Error("publish operation failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
	}
}

// ── Reader-facing handler (A18): anonymous reads + logged-in progress/follows ─

// ReaderHandler serves the public reading surface (plan A18).
type ReaderHandler struct {
	ps *service.PublishService
}

// NewReaderHandler creates a new ReaderHandler.
func NewReaderHandler(ps *service.PublishService) *ReaderHandler {
	return &ReaderHandler{ps: ps}
}

// PublicWorkResponse is the anonymous reader's view of a work.
type PublicWorkResponse struct {
	ID          int64  `json:"id"`
	Slug        string `json:"slug"`
	Title       string `json:"title"`
	Synopsis    string `json:"synopsis"`
	CoverURL    string `json:"cover_url"`
	AIInspired  bool   `json:"ai_inspired"`
	FollowCount int    `json:"follow_count"`
}

// PublicChapterResponse is the anonymous reader's view of a chapter.
type PublicChapterResponse struct {
	ID        int64  `json:"id"`
	WorkID    int64  `json:"work_id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	WordCount int    `json:"word_count"`
	Position  int    `json:"position"`
}

// PublicChapterSummary is the chapter-list item (no body).
type PublicChapterSummary struct {
	ID        int64 `json:"id"`
	Title     string `json:"title"`
	WordCount int   `json:"word_count"`
	Position  int   `json:"position"`
}

// GetWork handles GET /api/v1/read/works/:slug (anonymous)
func (h *ReaderHandler) GetWork(c *gin.Context) {
	slug := c.Param("slug")
	w, err := h.ps.PublicWorkBySlug(c.Request.Context(), slug)
	if err != nil {
		zap.L().Error("reader: get work failed", zap.String("slug", slug), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if w == nil {
		// private / not found / unlisted-but-wrong-slug all look the same to
		// avoid enumeration.
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "work not found"})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: PublicWorkResponse{
		ID: w.ID, Slug: w.Slug, Title: w.Title, Synopsis: w.Synopsis,
		CoverURL: w.CoverURL, AIInspired: w.AIInspired, FollowCount: w.FollowCount,
	}})
}

// ListChapters handles GET /api/v1/read/works/:slug/chapters (anonymous)
func (h *ReaderHandler) ListChapters(c *gin.Context) {
	slug := c.Param("slug")
	w, err := h.ps.PublicWorkBySlug(c.Request.Context(), slug)
	if err != nil {
		zap.L().Error("reader: list chapters failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if w == nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "work not found"})
		return
	}
	list, err := h.ps.PublicChapters(c.Request.Context(), w.ID)
	if err != nil {
		zap.L().Error("reader: list chapters query failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	out := make([]PublicChapterSummary, 0, len(list))
	for i := range list {
		out = append(out, PublicChapterSummary{
			ID: list[i].ID, Title: list[i].Title,
			WordCount: list[i].WordCount, Position: list[i].Position,
		})
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: out})
}

// GetChapter handles GET /api/v1/read/chapters/:pid (anonymous)
func (h *ReaderHandler) GetChapter(c *gin.Context) {
	pid, err := strconv.ParseInt(c.Param("pid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid pid"})
		return
	}
	ch, err := h.ps.PublicChapter(c.Request.Context(), pid)
	if err != nil {
		zap.L().Error("reader: get chapter failed", zap.Int64("pid", pid), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if ch == nil {
		// not found / private work / scheduled-not-yet-due all 404 identically.
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "chapter not found"})
		return
	}
	content := ""
	if ch.Content != nil {
		content = *ch.Content
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: PublicChapterResponse{
		ID: ch.ID, WorkID: ch.WorkID, Title: ch.Title,
		Content: content, WordCount: ch.WordCount, Position: ch.Position,
	}})
}

// GetProgress handles GET /api/v1/read/progress?work_id=X (logged in)
func (h *ReaderHandler) GetProgress(c *gin.Context) {
	workID, err := strconv.ParseInt(c.Query("work_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "work_id is required"})
		return
	}
	p, err := h.ps.GetProgress(c.Request.Context(), GetUserID(c), workID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if p == nil {
		c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: map[string]any{}})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: p})
}

// UpsertProgressRequest is the body for PUT /api/v1/read/progress.
type UpsertProgressRequest struct {
	WorkID    int64   `json:"work_id" binding:"required"`
	ChapterID int64   `json:"chapter_id" binding:"required"`
	Position  float64 `json:"position" binding:"required,min=0,max=1"`
}

// UpsertProgress handles PUT /api/v1/read/progress (logged in)
func (h *ReaderHandler) UpsertProgress(c *gin.Context) {
	var req UpsertProgressRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	if err := h.ps.UpsertProgress(c.Request.Context(), GetUserID(c), req.WorkID, req.ChapterID, req.Position); err != nil {
		zap.L().Error("reader: upsert progress failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// FollowRequest is the body for POST /api/v1/read/follows.
type FollowRequest struct {
	WorkID int64 `json:"work_id" binding:"required"`
	Notify *bool `json:"notify,omitempty"`
}

// Follow handles POST /api/v1/read/follows (logged in)
func (h *ReaderHandler) Follow(c *gin.Context) {
	var req FollowRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	notify := true
	if req.Notify != nil {
		notify = *req.Notify
	}
	if err := h.ps.Follow(c.Request.Context(), GetUserID(c), req.WorkID, notify); err != nil {
		zap.L().Error("reader: follow failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created"})
}

// Unfollow handles DELETE /api/v1/read/follows/:wid (logged in)
func (h *ReaderHandler) Unfollow(c *gin.Context) {
	wid, ok := parseID(c, "wid")
	if !ok {
		return
	}
	if err := h.ps.Unfollow(c.Request.Context(), GetUserID(c), wid); err != nil {
		zap.L().Error("reader: unfollow failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// suppress unused-import warning for time when builds trim reader code paths.
var _ = time.Now
