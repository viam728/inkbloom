package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// VolumeHandler handles volume HTTP requests.
type VolumeHandler struct {
	volumeService *service.VolumeService
}

// NewVolumeHandler creates a new VolumeHandler.
func NewVolumeHandler(vs *service.VolumeService) *VolumeHandler {
	return &VolumeHandler{volumeService: vs}
}

// CreateVolume handles POST /api/v1/volumes
func (h *VolumeHandler) CreateVolume(c *gin.Context) {
	var req dto.CreateVolumeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	volume, err := h.volumeService.CreateVolume(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: volume})
}

// ListVolumes handles GET /api/v1/novels/:id/volumes
func (h *VolumeHandler) ListVolumes(c *gin.Context) {
	novelID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return
	}

	volumes, err := h.volumeService.ListVolumes(c.Request.Context(), novelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: volumes})
}

// UpdateVolume handles PUT /api/v1/volumes/:id
func (h *VolumeHandler) UpdateVolume(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	var req dto.UpdateVolumeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	volume, err := h.volumeService.UpdateVolume(c.Request.Context(), id, &req)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "volume not found"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, dto.APIResponse{Code: 422, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: volume})
}

// DeleteVolume handles DELETE /api/v1/volumes/:id
func (h *VolumeHandler) DeleteVolume(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid id"})
		return
	}

	if err := h.volumeService.DeleteVolume(c.Request.Context(), id); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "volume not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "deleted"})
}
