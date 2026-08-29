package handler

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/authtoken"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// EventHandler ingests product-analytics batches (business plan v3 appendix B,
// construction plan A40).
//
// The endpoint is mounted on the ANONYMOUS group: readers who never log in
// must still be measurable (publishing penetration and reading volume are
// exactly the funnel metrics P1 is judged on). When a valid Bearer token is
// present the uid is attached, otherwise the event is stored under uid=0 with
// the client's anonymous id.
type EventHandler struct {
	events *service.EventService
	tokens *authtoken.Manager
}

// NewEventHandler creates a new EventHandler. tokens may be nil, in which
// case every batch is recorded as anonymous.
func NewEventHandler(es *service.EventService, tokens *authtoken.Manager) *EventHandler {
	return &EventHandler{events: es, tokens: tokens}
}

// Ingest handles POST /api/v1/events
func (h *EventHandler) Ingest(c *gin.Context) {
	var req dto.EventBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	if len(req.Events) > dto.MaxEventBatch {
		c.JSON(http.StatusRequestEntityTooLarge,
			dto.APIResponse{Code: 413, Message: "too many events in one batch"})
		return
	}

	resp, err := h.events.Ingest(c.Request.Context(), h.optionalUID(c), &req)
	if err != nil {
		// Analytics must never break the product: report the failure but keep
		// the response success-ish so clients stop retrying immediately.
		zap.L().Warn("analytics ingest failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

// optionalUID mirrors PublicHandler.optionalUID: a Bearer token is used when
// present and valid, otherwise the caller stays anonymous (uid=0). Invalid
// tokens are ignored rather than rejected.
func (h *EventHandler) optionalUID(c *gin.Context) int64 {
	if h.tokens == nil {
		return 0
	}
	auth := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return 0
	}
	claims, err := h.tokens.ParseTyped(strings.TrimSpace(strings.TrimPrefix(auth, prefix)), authtoken.TypeAccess)
	if err != nil {
		return 0
	}
	uid, err := claims.UID()
	if err != nil {
		return 0
	}
	return uid
}
