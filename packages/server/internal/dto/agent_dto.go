package dto

import "encoding/json"

// AgentChatMessage is one conversation message for the agent chat endpoint.
// Content is a plain string for text, or an OpenAI multi-modal parts array
// (text / image_url) when the author attaches an image or document.
type AgentChatMessage struct {
	Role    string `json:"role" binding:"required"`
	Content json.RawMessage `json:"content"`
}

// ContentString returns the message content as plain text when it is a string.
func (m AgentChatMessage) ContentString() string {
	var s string
	if err := json.Unmarshal(m.Content, &s); err == nil {
		return s
	}
	return ""
}

// ContentParts returns the message content as an OpenAI multi-modal parts array
// when it is not a plain string. The result is ready for direct message-body
// inclusion (forwarded verbatim to the LLM).
func (m AgentChatMessage) ContentParts() []any {
	var s string
	if err := json.Unmarshal(m.Content, &s); err == nil {
		return nil
	}
	var parts []any
	if err := json.Unmarshal(m.Content, &parts); err == nil {
		return parts
	}
	return nil
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
