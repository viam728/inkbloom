package dto

// AgentChatMessage is one conversation message for the agent chat endpoint.
type AgentChatMessage struct {
	Role    string `json:"role" binding:"required"`
	Content string `json:"content"`
}

// AgentChatRequest is the request for POST /ai/agent/chat. It drives one full
// Agent loop (the Go service executes tool calls and returns the final answer).
type AgentChatRequest struct {
	Messages []AgentChatMessage `json:"messages" binding:"required"`
	NovelID  int64              `json:"novel_id,omitempty"`
}

// AgentToolExecution records one tool call the Agent performed (for the UI to
// render what the Agent actually did).
type AgentToolExecution struct {
	Tool   string         `json:"tool"`
	Args   string         `json:"args"`
	Result map[string]any `json:"result"`
}

// AgentChatResponse is the response for POST /ai/agent/chat.
type AgentChatResponse struct {
	Content      string               `json:"content"`
	ToolExecutions []AgentToolExecution `json:"tool_executions"`
}
