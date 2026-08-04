package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/task_engine"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// TaskIdempotencyLookup is the optional repository capability used to resolve
// idempotency-key conflicts back to the pre-existing task. The GORM-backed
// TaskRepository will gain this method during the wiring phase; until then the
// handler degrades to a plain 409 response.
type TaskIdempotencyLookup interface {
	GetByIdempotencyKey(ctx context.Context, key string) (*model.Task, error)
}

// AIGCHandler handles HTTP requests for AIGC image generation and asset management.
type AIGCHandler struct {
	engine    *task_engine.TaskEngine
	assetRepo repository.AssetRepository
	taskRepo  repository.TaskRepository
	logger    *zap.Logger
}

// AIGCHandlerOption customizes an AIGCHandler constructed by NewAIGCHandler.
type AIGCHandlerOption func(*AIGCHandler)

// WithTaskRepo injects the task repository used by GetTaskStatus and by
// idempotency-conflict lookups in GenerateImage.
func WithTaskRepo(repo repository.TaskRepository) AIGCHandlerOption {
	return func(h *AIGCHandler) { h.taskRepo = repo }
}

// WithAIGCLogger injects a zap logger. Defaults to zap.NewNop() when omitted.
func WithAIGCLogger(logger *zap.Logger) AIGCHandlerOption {
	return func(h *AIGCHandler) { h.logger = logger }
}

// NewAIGCHandler creates a new AIGCHandler.
//
// Signature note (for the wiring task): pass repository.NewTaskRepository via
// WithTaskRepo and the app logger via WithAIGCLogger, e.g.
// handler.NewAIGCHandler(engine, assetRepo, handler.WithTaskRepo(taskRepo), handler.WithAIGCLogger(logger)).
func NewAIGCHandler(engine *task_engine.TaskEngine, assetRepo repository.AssetRepository, opts ...AIGCHandlerOption) *AIGCHandler {
	h := &AIGCHandler{
		engine:    engine,
		assetRepo: assetRepo,
		logger:    zap.NewNop(),
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// taskStatusResponse is the payload returned by GetTaskStatus.
type taskStatusResponse struct {
	TaskID      string          `json:"task_id"`
	Type        string          `json:"type"`
	Status      string          `json:"status"`
	Progress    int16           `json:"progress"`
	ErrorMsg    string          `json:"error_msg,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	StartedAt   *time.Time      `json:"started_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

// GenerateImage handles POST /api/v1/aigc/generate — create an image generation task.
// The task carries an idempotency key derived from the prompt and size-related
// parameters (sha256, tasks.idempotency_key UNIQUE). A duplicate submission
// resolves to the pre-existing task instead of failing with 500.
func (h *AIGCHandler) GenerateImage(c *gin.Context) {
	var req dto.ImageGenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	// Set defaults
	if req.Width <= 0 {
		req.Width = 1024
	}
	if req.Height <= 0 {
		req.Height = 1024
	}
	if req.Provider == "" {
		req.Provider = "pollinations"
	}

	// Idempotency key over the key generation parameters (64-char hex fits
	// tasks.idempotency_key VARCHAR(64)).
	keySource := fmt.Sprintf("image_gen|%s|%d|%d|%s", req.Prompt, req.Width, req.Height, req.Provider)
	sum := sha256.Sum256([]byte(keySource))
	idempotencyKey := hex.EncodeToString(sum[:])

	// Build task payload
	var novelID int64
	if req.NovelID != nil {
		novelID = *req.NovelID
	}
	payload := dto.AIGCGeneratePayload{
		Prompt:   req.Prompt,
		Width:    req.Width,
		Height:   req.Height,
		Provider: req.Provider,
		NovelID:  novelID,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to marshal payload"})
		return
	}

	// Create task
	task := model.Task{
		ID:             uuid.New().String(),
		Type:           "image_gen",
		Payload:        payloadJSON,
		IdempotencyKey: idempotencyKey,
		NovelID:        req.NovelID,
		ChapterID:      req.ChapterID,
	}

	if err := h.engine.Submit(c.Request.Context(), task); err != nil {
		if isUniqueViolation(err) {
			h.logger.Info("duplicate image generation request, returning existing task",
				zap.String("idempotency_key", idempotencyKey),
			)
			if existing, found := h.findTaskByIdempotencyKey(c, idempotencyKey); found {
				c.JSON(http.StatusOK, dto.APIResponse{
					Code:    200,
					Message: "task already exists",
					Data: dto.AIGCTaskResponse{
						TaskID:   existing.ID,
						Type:     existing.Type,
						Status:   existing.Status,
						Progress: existing.Progress,
					},
				})
				return
			}
			// Conflict detected but the existing task could not be resolved
			// (repository not wired yet). Still honor idempotent semantics —
			// never surface this as a 500.
			c.JSON(http.StatusConflict, dto.APIResponse{
				Code:    409,
				Message: "an identical image generation task already exists",
			})
			return
		}
		h.logger.Error("failed to submit image generation task", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to submit task: " + err.Error()})
		return
	}

	h.logger.Info("image generation task created",
		zap.String("task_id", task.ID),
		zap.String("idempotency_key", idempotencyKey),
	)

	c.JSON(http.StatusAccepted, dto.APIResponse{
		Code:    202,
		Message: "task created",
		Data: dto.AIGCTaskResponse{
			TaskID:   task.ID,
			Type:     task.Type,
			Status:   "pending",
			Progress: 0,
		},
	})
}

// findTaskByIdempotencyKey resolves an existing task by its idempotency key.
// Returns found=false when the repository is not wired, lacks the lookup
// capability, or the record is missing.
func (h *AIGCHandler) findTaskByIdempotencyKey(c *gin.Context, key string) (*model.Task, bool) {
	if h.taskRepo == nil {
		return nil, false
	}
	lookup, ok := h.taskRepo.(TaskIdempotencyLookup)
	if !ok {
		h.logger.Warn("task repository does not implement GetByIdempotencyKey yet")
		return nil, false
	}
	existing, err := lookup.GetByIdempotencyKey(c.Request.Context(), key)
	if err != nil {
		h.logger.Warn("failed to look up task by idempotency key",
			zap.String("idempotency_key", key),
			zap.Error(err),
		)
		return nil, false
	}
	return existing, true
}

// isUniqueViolation reports whether err is a PostgreSQL unique-constraint
// violation (SQLSTATE 23505) surfaced through GORM/pgx.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key")
}

// GetTaskStatus handles GET /api/v1/aigc/tasks/:id — query task status from
// the tasks table through TaskRepository.
func (h *AIGCHandler) GetTaskStatus(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "task id is required"})
		return
	}

	if h.taskRepo == nil {
		h.logger.Warn("GetTaskStatus called but TaskRepository is not wired")
		c.JSON(http.StatusServiceUnavailable, dto.APIResponse{
			Code:    503,
			Message: "task repository not configured; use /api/v1/tasks/:id endpoint for task status",
		})
		return
	}

	task, err := h.taskRepo.GetByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "task not found"})
			return
		}
		h.logger.Error("failed to query task", zap.String("task_id", id), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to query task: " + err.Error()})
		return
	}

	var result json.RawMessage
	if len(task.Result) > 0 {
		result = json.RawMessage(task.Result)
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: taskStatusResponse{
			TaskID:      task.ID,
			Type:        task.Type,
			Status:      task.Status,
			Progress:    task.Progress,
			ErrorMsg:    task.ErrorMsg,
			Result:      result,
			CreatedAt:   task.CreatedAt,
			StartedAt:   task.StartedAt,
			CompletedAt: task.CompletedAt,
		},
	})
}

// ListAssets handles GET /api/v1/aigc/assets — list assets with optional novel_id filter.
func (h *AIGCHandler) ListAssets(c *gin.Context) {
	novelIDStr := c.Query("novel_id")
	if novelIDStr == "" {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "novel_id is required"})
		return
	}

	novelID, err := strconv.ParseInt(novelIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel_id"})
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	assets, err := h.assetRepo.ListByNovel(c.Request.Context(), novelID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data:    assets,
	})
}

// GetAsset handles GET /api/v1/aigc/assets/:id — get asset details.
func (h *AIGCHandler) GetAsset(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	asset, err := h.assetRepo.GetByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "asset not found"})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data:    asset,
	})
}

// DeleteAsset handles DELETE /api/v1/aigc/assets/:id — delete an asset.
func (h *AIGCHandler) DeleteAsset(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	if err := h.assetRepo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}
