package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

// BranchHandler serves the world-branch tree (世界线) endpoints.
type BranchHandler struct {
	bs *service.BranchService
}

// NewBranchHandler creates a new BranchHandler.
func NewBranchHandler(bs *service.BranchService) *BranchHandler {
	return &BranchHandler{bs: bs}
}

// List handles GET /api/v1/novels/:id/branches
func (h *BranchHandler) List(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	list, err := h.bs.List(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		zap.L().Error("list branches failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	if list == nil {
		list = []model.NovelBranch{}
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: list})
}

// Create handles POST /api/v1/novels/:id/branches
func (h *BranchHandler) Create(c *gin.Context) {
	novelID, ok := parseID(c, "id")
	if !ok {
		return
	}
	var req dto.CreateBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	req.NovelID = novelID
	b, err := h.bs.Create(c.Request.Context(), GetUserID(c), &req)
	if err != nil {
		if errors.Is(err, service.ErrBranchTitleRequired) {
			c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
			return
		}
		zap.L().Error("create branch failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: b})
}

// Update handles PUT /api/v1/branches/:bid
func (h *BranchHandler) Update(c *gin.Context) {
	bid, err := strconv.ParseInt(c.Param("bid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid branch id"})
		return
	}
	var req dto.UpdateBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}
	if err := h.bs.Update(c.Request.Context(), GetUserID(c), bid, &req); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// Delete handles DELETE /api/v1/branches/:bid?subtree=1
func (h *BranchHandler) Delete(c *gin.Context) {
	bid, err := strconv.ParseInt(c.Param("bid"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid branch id"})
		return
	}
	var delErr error
	if c.Query("subtree") == "1" {
		delErr = h.bs.DeleteSubtree(c.Request.Context(), GetUserID(c), bid)
	} else {
		delErr = h.bs.Delete(c.Request.Context(), GetUserID(c), bid)
	}
	if delErr != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: delErr.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}
