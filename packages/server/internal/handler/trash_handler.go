package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// TrashHandler 垃圾桶：删除要点进桶 / 列表 / 重选幕恢复 / 彻底删除。
type TrashHandler struct {
	trashSvc *service.TrashService
}

func NewTrashHandler(svc *service.TrashService) *TrashHandler {
	return &TrashHandler{trashSvc: svc}
}

func parseNovelID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return 0, false
	}
	return id, true
}

func parseTrashID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("trashId"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid trash id"})
		return 0, false
	}
	return id, true
}

// List handles GET /api/v1/novels/:id/trash — 回收站列表。
func (h *TrashHandler) List(c *gin.Context) {
	novelID, ok := parseNovelID(c)
	if !ok {
		return
	}
	items, err := h.trashSvc.List(c.Request.Context(), GetUserID(c), novelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: items})
}

// TrashNode handles POST /api/v1/novels/:id/trash — 删除要点进桶
// （节点摘出大纲 + 绑定章节软删 + 写回收记录，一个事务）。
func (h *TrashHandler) TrashNode(c *gin.Context) {
	novelID, ok := parseNovelID(c)
	if !ok {
		return
	}
	var req dto.TrashNodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid request: " + err.Error()})
		return
	}
	item, err := h.trashSvc.TrashNode(c.Request.Context(), GetUserID(c), novelID, req.ActID, req.NodeID)
	if err != nil {
		status := http.StatusInternalServerError
		if err.Error() == "act_id 与 node_id 不能为空" {
			status = http.StatusBadRequest
		}
		c.JSON(status, dto.APIResponse{Code: status, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: item})
}

// Restore handles POST /api/v1/novels/:id/trash/:trashId/restore —
// 恢复进大纲（body.target_act_id 指定目标幕；空则新建幕）。
func (h *TrashHandler) Restore(c *gin.Context) {
	novelID, ok := parseNovelID(c)
	if !ok {
		return
	}
	trashID, ok := parseTrashID(c)
	if !ok {
		return
	}
	var req dto.RestoreTrashRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		// body 可为空（未选幕 → 新建幕）。
		req.TargetActID = ""
	}
	if err := h.trashSvc.Restore(c.Request.Context(), GetUserID(c), novelID, trashID, req.TargetActID); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, service.ErrTrashNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, dto.APIResponse{Code: status, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// Purge handles DELETE /api/v1/novels/:id/trash/:trashId — 彻底删除（不可恢复）。
func (h *TrashHandler) Purge(c *gin.Context) {
	novelID, ok := parseNovelID(c)
	if !ok {
		return
	}
	trashID, ok := parseTrashID(c)
	if !ok {
		return
	}
	if err := h.trashSvc.Purge(c.Request.Context(), GetUserID(c), novelID, trashID); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, service.ErrTrashNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, dto.APIResponse{Code: status, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}
