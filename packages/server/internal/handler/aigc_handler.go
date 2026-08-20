package handler

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service"
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
	engine       *task_engine.TaskEngine
	assetRepo    repository.AssetRepository
	taskRepo     repository.TaskRepository
	recordRepo   repository.AIGCRecordRepository // AIGC history (task #64)
	logger       *zap.Logger
	tokenService *service.TokenService // optional; bills image generation (task #43, M4)
	csChecker    contentsafety.Checker // optional; content-safety gateway (v2 §9.1)
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

// WithAIGCTokenService attaches the M4 token billing service. When set,
// GenerateImage deducts a flat per-image fee before submitting the task.
func WithAIGCTokenService(ts *service.TokenService) AIGCHandlerOption {
	return func(h *AIGCHandler) { h.tokenService = ts }
}

// WithAIGCRecordRepo injects the AIGC history repository used by
// ListAIGCRecords (task #64).
func WithAIGCRecordRepo(repo repository.AIGCRecordRepository) AIGCHandlerOption {
	return func(h *AIGCHandler) { h.recordRepo = repo }
}

// WithContentSafety injects the content-safety gateway (v2 §9.1). When set,
// GenerateImage checks the prompt before charging/submitting; a rejection
// returns 422 with a compliance message and records the violation.
func WithContentSafety(cs contentsafety.Checker) AIGCHandlerOption {
	return func(h *AIGCHandler) { h.csChecker = cs }
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

	// Content-safety gate (v2 §9.1): check the prompt BEFORE charging and
	// submitting. A rejection returns 422 and records the violation.
	if h.csChecker != nil {
		res, err := h.csChecker.CheckText(contentsafety.WithEndpoint(c.Request.Context(), "/api/v1/aigc/generate"), req.Prompt)
		if err != nil {
			h.logger.Warn("content safety check error, failing open", zap.Error(err))
		} else if !res.Pass {
			c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: "生成内容未通过安全审核，请调整描述后重试"})
			return
		}
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
	// Scope defaults to novel; media/memo route the output directory
	// (task #64).
	switch req.Scope {
	case "", model.AssetScopeNovel:
		req.Scope = model.AssetScopeNovel
	case model.AssetScopeMedia, model.AssetScopeMemo:
		// keep as-is
	default:
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid scope: " + req.Scope})
		return
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
		Scope:    req.Scope,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to marshal payload"})
		return
	}

	// Create task (owned by the requesting user; M1 isolation)
	task := model.Task{
		ID:             uuid.New().String(),
		UserID:         GetUserID(c),
		Type:           "image_gen",
		Payload:        payloadJSON,
		IdempotencyKey: idempotencyKey,
		NovelID:        req.NovelID,
		ChapterID:      req.ChapterID,
	}

	// M4 (task #43): image generation costs a flat per-image fee, charged
	// BEFORE submission. Idempotent repeats resolve to the existing task
	// without charging; a failed submission is compensated with a refund.
	charged := false
	if h.tokenService != nil {
		uid := GetUserID(c)
		ctx := c.Request.Context()

		ok, err := h.tokenService.CanConsume(ctx, uid, model.ImageGenUnits)
		if err != nil {
			h.logger.Error("token pre-check failed for image generation", zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "计费预检失败，请稍后重试"})
			return
		}
		if !ok {
			c.JSON(http.StatusPaymentRequired, dto.APIResponse{Code: 402, Message: "Token 余额不足，请充值"})
			return
		}
		// Resolve an idempotent repeat BEFORE charging so retries never
		// deduct twice.
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

		endpoint := "/api/v1/aigc/generate"
		refType := model.LedgerRefTypeTask
		refID := task.ID
		meta := service.ConsumeMeta{
			Reason:   model.LedgerReasonImageGen,
			RefType:  &refType,
			RefID:    &refID,
			Endpoint: &endpoint,
		}
		if err := h.tokenService.Consume(ctx, uid, model.ImageGenUnits, meta); err != nil {
			if errors.Is(err, service.ErrTokenInsufficient) {
				c.JSON(http.StatusPaymentRequired, dto.APIResponse{Code: 402, Message: "Token 余额不足，请充值"})
				return
			}
			h.logger.Error("failed to deduct image generation fee", zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "计费失败，请稍后重试"})
			return
		}
		charged = true
	}

	if err := h.engine.Submit(c.Request.Context(), task); err != nil {
		if charged {
			// Compensating refund: the task was never created, so the user
			// must not pay for it.
			refType := model.LedgerRefTypeTask
			refID := task.ID
			endpoint := "/api/v1/aigc/generate"
			if refundErr := h.tokenService.Refund(c.Request.Context(), GetUserID(c), model.ImageGenUnits, service.ConsumeMeta{
				Reason:   model.LedgerReasonRefund,
				RefType:  &refType,
				RefID:    &refID,
				Endpoint: &endpoint,
			}); refundErr != nil {
				h.logger.Error("failed to refund image generation fee",
					zap.String("task_id", task.ID),
					zap.Int64("units", model.ImageGenUnits),
					zap.Error(refundErr),
				)
			}
		}
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
	// Ownership guard: never hand another user's task back (M1 isolation).
	if existing.UserID != GetUserID(c) {
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
	// Ownership guard: foreign tasks look like missing ones (M1 isolation).
	if task.UserID != GetUserID(c) {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "task not found"})
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

// ListAssets handles GET /api/v1/aigc/assets — list AIGC assets. novel_id
// is optional since task #64: omitted, it returns the user's AIGC assets
// across all novels. Response stays a bare asset array for compatibility.
func (h *AIGCHandler) ListAssets(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	var (
		assets []model.Asset
		err    error
	)
	if novelIDStr := c.Query("novel_id"); novelIDStr != "" {
		novelID, perr := strconv.ParseInt(novelIDStr, 10, 64)
		if perr != nil {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel_id"})
			return
		}
		assets, err = h.assetRepo.ListByNovel(c.Request.Context(), GetUserID(c), novelID, limit)
	} else {
		assets, err = h.assetRepo.ListAll(c.Request.Context(), GetUserID(c), limit)
	}
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

// aigcRecordItem joins an AIGC history record with its asset snapshot
// (task #64).
type aigcRecordItem struct {
	ID          int64     `json:"id"`
	TaskID      string    `json:"task_id"`
	Prompt      string    `json:"prompt"`
	Provider    string    `json:"provider"`
	AssetID     int64     `json:"asset_id"`
	NovelID     *int64    `json:"novel_id"`
	Scope       string    `json:"scope"`
	Width       int32     `json:"width"`
	Height      int32     `json:"height"`
	CreatedAt   time.Time `json:"created_at"`
	URL         string    `json:"url"`
	ThumbURL    string    `json:"thumb_url"`
	DisplayName string    `json:"display_name"`
	ContentHash string    `json:"content_hash"`
}

// ListAIGCRecords handles GET /api/v1/aigc/records — the global AIGC
// generation history (AIGC only), keyset-paginated over (created_at DESC,
// id DESC) in the same style as /api/v1/images (task #64).
func (h *AIGCHandler) ListAIGCRecords(c *gin.Context) {
	if h.recordRepo == nil {
		c.JSON(http.StatusServiceUnavailable, dto.APIResponse{Code: 503, Message: "aigc record repository not configured"})
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	var novelID *int64
	if s := c.Query("novel_id"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel_id"})
			return
		}
		novelID = &v
	}

	recordScope := c.Query("scope")
	switch recordScope {
	case "", model.AssetScopeNovel, model.AssetScopeMedia, model.AssetScopeMemo:
	default:
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid scope"})
		return
	}

	var cursorTime *time.Time
	var cursorID int64
	if cur := c.Query("cursor"); cur != "" {
		t, id, err := decodeAIGCCursor(cur)
		if err != nil {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid cursor"})
			return
		}
		cursorTime, cursorID = &t, id
	}

	userID := GetUserID(c)
	records, err := h.recordRepo.ListByUser(c.Request.Context(), userID, novelID, recordScope, limit, cursorTime, cursorID)
	if err != nil {
		h.logger.Error("failed to list aigc records", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to list aigc records"})
		return
	}

	items := make([]aigcRecordItem, 0, len(records))
	for _, r := range records {
		item := aigcRecordItem{
			ID:        r.ID,
			TaskID:    r.TaskID,
			Prompt:    r.Prompt,
			Provider:  r.Provider,
			AssetID:   r.AssetID,
			NovelID:   r.NovelID,
			Scope:     r.Scope,
			Width:     r.Width,
			Height:    r.Height,
			CreatedAt: r.CreatedAt,
		}
		// Asset snapshot: GetByID is unscoped (static-route legacy), so
		// enforce ownership here (M1 isolation).
		if asset, aerr := h.assetRepo.GetByID(c.Request.Context(), r.AssetID); aerr == nil && asset.UserID == userID {
			item.URL = asset.FilePath
			item.ThumbURL = asset.ThumbnailPath
			item.DisplayName = asset.DisplayName
			item.ContentHash = asset.ContentHash
		}
		items = append(items, item)
	}

	nextCursor := ""
	if len(records) == limit {
		last := records[len(records)-1]
		nextCursor = encodeAIGCCursor(last.CreatedAt, last.ID)
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: gin.H{
			"items":       items,
			"next_cursor": nextCursor,
		},
	})
}

// encodeAIGCCursor packs (created_at, id) into an opaque base64 cursor,
// same format as the gallery cursor (task #64).
func encodeAIGCCursor(t time.Time, id int64) string {
	raw := t.UTC().Format(time.RFC3339Nano) + "|" + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeAIGCCursor is the inverse of encodeAIGCCursor.
func decodeAIGCCursor(cursor string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, 0, err
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, 0, fmt.Errorf("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, 0, err
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return time.Time{}, 0, err
	}
	return t, id, nil
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

	if err := h.assetRepo.Delete(c.Request.Context(), GetUserID(c), id); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}
