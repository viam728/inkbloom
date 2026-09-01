package handler

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// AgentHandler exposes the conversational creation Agent endpoint.
type AgentHandler struct {
	agentSvc *service.AgentService
}

// NewAgentHandler creates a new AgentHandler.
func NewAgentHandler(svc *service.AgentService) *AgentHandler {
	return &AgentHandler{agentSvc: svc}
}

// Chat handles POST /api/v1/agent/chat — one full Agent loop.
func (h *AgentHandler) Chat(c *gin.Context) {
	var req dto.AgentChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid request: " + err.Error()})
		return
	}
	if len(req.Messages) == 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "messages cannot be empty"})
		return
	}

	msgs := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		content := any(m.ContentString())
		if content == "" {
			if parts := m.ContentParts(); parts != nil {
				content = parts
			}
		}
		msgs = append(msgs, map[string]any{"role": m.Role, "content": content})
	}

	content, executed, err := h.agentSvc.Run(c.Request.Context(), GetUserID(c), req.NovelID, msgs)
	if err != nil {
		c.JSON(http.StatusBadGateway, dto.APIResponse{Code: 502, Message: "agent failed: " + err.Error()})
		return
	}

	executions := make([]dto.AgentToolExecution, 0, len(executed))
	for _, e := range executed {
		exec := dto.AgentToolExecution{}
		if t, ok := e["tool"].(string); ok {
			exec.Tool = t
		}
		if a, ok := e["args"].(string); ok {
			exec.Args = a
		}
		if r, ok := e["result"].(string); ok {
			// 解析 JSON 结果，供前端按字段渲染（如 write_chapter 的 before/after 字数）。
			var parsed map[string]any
			if json.Unmarshal([]byte(r), &parsed) == nil {
				exec.Result = parsed
			} else {
				exec.Result = map[string]any{"raw": r}
			}
		}
		executions = append(executions, exec)
	}

	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: dto.AgentChatResponse{
			Content:       content,
			ToolExecutions: executions,
		},
	})
}
