package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// importMaxBytes caps accepted .inkbloom uploads at 500MB
// (frozen contract; mirrors service.importMaxBytes).
const importMaxBytes = 500 << 20

// SyncHandler serves the M5 .inkbloom data export/import endpoints.
type SyncHandler struct {
	syncService *service.SyncService
	logger      *zap.Logger
}

// NewSyncHandler creates a new SyncHandler.
func NewSyncHandler(ss *service.SyncService, logger *zap.Logger) *SyncHandler {
	return &SyncHandler{syncService: ss, logger: logger}
}

// Export handles GET /api/v1/sync/export — streams the user's full dataset
// as a .inkbloom zip (manifest.json + assets/ directory).
func (h *SyncHandler) Export(c *gin.Context) {
	userID := GetUserID(c)
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}

	filename := time.Now().Format("InkBloom-20060102-1504.inkbloom")
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	_, err := h.syncService.Export(c.Request.Context(), userID, c.Writer)
	if err != nil {
		h.logger.Error("sync export failed", zap.Int64("user_id", userID), zap.Error(err))
		// The stream already started once bytes were written; only a clean
		// (nothing sent yet) failure can still answer JSON.
		if c.Writer.Size() == 0 {
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "export failed: " + err.Error()})
		}
		return
	}
}

// Import handles POST /api/v1/sync/import — multipart field "file" holding
// one .inkbloom package (≤500MB). Answers 201 with merge counters.
func (h *SyncHandler) Import(c *gin.Context) {
	userID := GetUserID(c)
	if userID == 0 {
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}

	file, _, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: `missing multipart field "file"`})
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, int64(importMaxBytes)+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "failed to read upload"})
		return
	}
	if len(data) > importMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, dto.APIResponse{Code: 413, Message: "file exceeds the 500MB limit"})
		return
	}

	result, err := h.syncService.Import(c.Request.Context(), userID, data)
	if err != nil {
		if errors.Is(err, service.ErrImportPackage) {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
			return
		}
		h.logger.Error("sync import failed", zap.Int64("user_id", userID), zap.Error(err))
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "import failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "ok", Data: result})
}
