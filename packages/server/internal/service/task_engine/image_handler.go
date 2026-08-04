package task_engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// ImageTaskHandler processes image generation tasks by calling the Python AI service.
type ImageTaskHandler struct {
	aiServiceURL string
	assetRepo    repository.AssetRepository
	logger       *zap.Logger
	httpClient   *http.Client
}

// NewImageTaskHandler creates a new ImageTaskHandler.
func NewImageTaskHandler(aiServiceURL string, assetRepo repository.AssetRepository, logger *zap.Logger) *ImageTaskHandler {
	return &ImageTaskHandler{
		aiServiceURL: aiServiceURL,
		assetRepo:    assetRepo,
		logger:       logger,
		httpClient: &http.Client{
			Timeout: 180 * time.Second,
		},
	}
}

// Type returns the unique task type identifier.
func (h *ImageTaskHandler) Type() string { return "image_gen" }

// MaxRetries returns the maximum number of retries for image generation.
func (h *ImageTaskHandler) MaxRetries() int { return 3 }

// Execute processes an image generation task.
func (h *ImageTaskHandler) Execute(ctx context.Context, task model.Task) (json.RawMessage, error) {
	// 1. Parse the task payload
	var payload dto.AIGCGeneratePayload
	if err := json.Unmarshal(task.Payload, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}

	h.logger.Info("executing image generation",
		zap.String("task_id", task.ID),
		zap.String("prompt", payload.Prompt),
		zap.String("provider", payload.Provider),
	)

	// 2. Build the request to the Python AI service
	reqBody, err := json.Marshal(map[string]interface{}{
		"prompt":   payload.Prompt,
		"width":    payload.Width,
		"height":   payload.Height,
		"provider": payload.Provider,
		"novel_id": payload.NovelID,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	url := h.aiServiceURL + "/api/aigc/generate"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// 3. Call the Python AI service
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call ai service: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ai service returned %d: %s", resp.StatusCode, string(body))
	}

	// 4. Parse the result
	var result dto.AIGCGenerateResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("unmarshal result: %w", err)
	}

	// Check for error in response
	if errMsg, ok := checkErrorField(body); ok {
		return nil, fmt.Errorf("ai service error: %s", errMsg)
	}

	// 5. Create the asset record in the database
	var novelID *int64
	if payload.NovelID > 0 {
		novelID = &payload.NovelID
	}

	asset := &model.Asset{
		NovelID:       novelID,
		TaskID:        task.ID,
		FilePath:      result.FilePath,
		ThumbnailPath: result.ThumbnailPath,
		Prompt:        payload.Prompt,
		Provider:      result.Provider,
		Width:         result.Width,
		Height:        result.Height,
		FileSize:      result.FileSize,
	}

	// Also set chapter_id if present in the original task
	if task.ChapterID != nil {
		asset.ChapterID = task.ChapterID
	}

	if err := h.assetRepo.Create(ctx, asset); err != nil {
		h.logger.Warn("failed to create asset record", zap.Error(err))
		// Don't fail the task if DB insert fails — image was still generated
	}

	// 6. Return the result as JSON
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}

	h.logger.Info("image generation completed",
		zap.String("task_id", task.ID),
		zap.String("url", result.URL),
	)

	return resultJSON, nil
}

// checkErrorField checks if the JSON body contains an "error" field.
func checkErrorField(body []byte) (string, bool) {
	var errResp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &errResp); err == nil && errResp.Error != "" {
		return errResp.Error, true
	}
	return "", false
}
