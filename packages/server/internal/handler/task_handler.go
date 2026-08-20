package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/task_engine"
)

// TaskAPIHandler handles HTTP requests for task management.
type TaskAPIHandler struct {
	engine *task_engine.TaskEngine
	repo   repository.TaskRepository
}

// NewTaskAPIHandler creates a new TaskAPIHandler.
func NewTaskAPIHandler(engine *task_engine.TaskEngine, repo repository.TaskRepository) *TaskAPIHandler {
	return &TaskAPIHandler{
		engine: engine,
		repo:   repo,
	}
}

// ListTasks handles GET /api/v1/tasks — list tasks with optional status filter.
func (h *TaskAPIHandler) ListTasks(c *gin.Context) {
	status := c.DefaultQuery("status", "")
	limit := 50

	tasks, err := h.repo.ListByUser(c.Request.Context(), GetUserID(c), status, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: "failed to list tasks: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "success",
		Data:    tasks,
	})
}

// GetTask handles GET /api/v1/tasks/:id — get task details.
func (h *TaskAPIHandler) GetTask(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: "task id is required",
		})
		return
	}

	task, err := h.repo.GetByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{
			Code:    404,
			Message: "task not found",
		})
		return
	}
	// Ownership guard: foreign tasks look like missing ones (M1 isolation).
	if task.UserID != GetUserID(c) {
		c.JSON(http.StatusNotFound, dto.APIResponse{
			Code:    404,
			Message: "task not found",
		})
		return
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "success",
		Data:    task,
	})
}
