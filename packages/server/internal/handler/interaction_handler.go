package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// InteractionHandler serves the E5 reader-interaction endpoints (plan A28).
type InteractionHandler struct {
	is *service.InteractionService
}

// NewInteractionHandler creates a new InteractionHandler.
func NewInteractionHandler(is *service.InteractionService) *InteractionHandler {
	return &InteractionHandler{is: is}
}

// List handles GET /api/v1/read/chapters/:pid/interactions (anonymous).
func (h *InteractionHandler) List(c *gin.Context) {
	pid, err := strconv.ParseInt(c.Param("pid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid pid"})
		return
	}
	resp, err := h.is.List(c.Request.Context(), pid, GetUserID(c))
	if err != nil {
		h.respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: resp})
}

// Create handles POST /api/v1/read/chapters/:pid/interactions (logged in).
func (h *InteractionHandler) Create(c *gin.Context) {
	pid, err := strconv.ParseInt(c.Param("pid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid pid"})
		return
	}
	var req dto.CreateInteractionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	out, err := h.is.Create(c.Request.Context(), GetUserID(c), pid, &req)
	if err != nil {
		h.respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: out})
}

// Like handles POST /api/v1/interactions/:iid/like (logged in).
func (h *InteractionHandler) Like(c *gin.Context) {
	iid, err := strconv.ParseInt(c.Param("iid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid iid"})
		return
	}
	out, err := h.is.ToggleLike(c.Request.Context(), GetUserID(c), iid)
	if err != nil {
		h.respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: out})
}

// Adopt handles POST /api/v1/publish/interactions/:iid/adopt (author only).
func (h *InteractionHandler) Adopt(c *gin.Context) {
	iid, err := strconv.ParseInt(c.Param("iid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid iid"})
		return
	}
	if err := h.is.Adopt(c.Request.Context(), GetUserID(c), iid); err != nil {
		h.respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "adopted"})
}

// Hide handles DELETE /api/v1/interactions/:iid (author or commenter).
func (h *InteractionHandler) Hide(c *gin.Context) {
	iid, err := strconv.ParseInt(c.Param("iid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid iid"})
		return
	}
	if err := h.is.Hide(c.Request.Context(), GetUserID(c), iid); err != nil {
		h.respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "hidden"})
}

func (h *InteractionHandler) respondError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound), errors.Is(err, service.ErrInteractionNotFound):
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "not found"})
	case errors.Is(err, service.ErrInteractionInvalid):
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "互动内容格式不合法"})
	case errors.Is(err, contentsafety.ErrContentRejected):
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: "评论未通过内容审核"})
	default:
		zap.L().Error("interaction operation failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
	}
}
