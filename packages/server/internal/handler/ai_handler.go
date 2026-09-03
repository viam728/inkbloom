package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/breaker"
	"github.com/inkbloom/server/internal/service"
	"go.uber.org/zap"
)

const (
	// aiTextTimeout is the default timeout for non-streaming AI text proxies.
	aiTextTimeout = 60 * time.Second
	// inlineContextMaxChars limits how much preceding text is embedded into
	// inline/rewrite prompts to keep upstream token usage bounded.
	inlineContextMaxChars = 2000
)

// AIHandler handles AI chat HTTP requests.
// It proxies streaming requests to the Python AI service via HTTP and
// automatically injects novel/chapter context using AIContextBuilder.
type AIHandler struct {
	aiServiceURL   string // e.g. "http://localhost:8100"
	httpClient     *http.Client
	jsonClient     *http.Client // dedicated client with aiTextTimeout for non-streaming proxies
	logger         *zap.Logger
	contextBuilder *service.AIContextBuilder
	agentContext   *service.AgentContextService // optional; required by AgentGenerate
	breaker        *breaker.Breaker             // optional circuit breaker guarding non-streaming upstream calls
	tokenService   *service.TokenService        // optional; bills non-streaming AI calls (task #43, M4)
}

// AIHandlerOption customizes an AIHandler constructed by NewAIHandler.
type AIHandlerOption func(*AIHandler)

// WithAIBreaker attaches a circuit breaker that guards non-streaming
// upstream JSON calls (proxyJSON). Streaming calls are not breaker-guarded.
func WithAIBreaker(cb *breaker.Breaker) AIHandlerOption {
	return func(h *AIHandler) { h.breaker = cb }
}

// WithAgentContextService attaches the agent context assembler used by the
// AgentGenerate endpoint to build the frozen upstream payload.
func WithAgentContextService(svc *service.AgentContextService) AIHandlerOption {
	return func(h *AIHandler) { h.agentContext = svc }
}

// WithTokenService attaches the M4 token billing service. When set, every
// billed non-streaming proxy (all LLM-backed endpoints) pre-checks the
// balance and deducts usage-based units after a successful upstream call.
func WithTokenService(ts *service.TokenService) AIHandlerOption {
	return func(h *AIHandler) { h.tokenService = ts }
}

// NewAIHandler creates a new AIHandler.
func NewAIHandler(
	aiServiceURL string,
	contextBuilder *service.AIContextBuilder,
	logger *zap.Logger,
	opts ...AIHandlerOption,
) *AIHandler {
	h := &AIHandler{
		aiServiceURL: strings.TrimRight(aiServiceURL, "/"),
		httpClient: &http.Client{
			Timeout: 5 * time.Minute, // long timeout for streaming
		},
		jsonClient: &http.Client{
			// 硬顶兜底：实际超时由 proxyJSON 的 per-request context 控制
			// （默认 60s；story-overview 120s）。此值须大于最长的 context 超时。
			Timeout: 150 * time.Second,
		},
		logger:         logger,
		contextBuilder: contextBuilder,
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// buildContextMessages uses AIContextBuilder to fetch rich novel/chapter context
// and returns system messages to inject into the chat conversation.
func (h *AIHandler) buildContextMessages(c *gin.Context, novelID, chapterID int64, cursorText string) []map[string]interface{} {
	if novelID <= 0 {
		return nil
	}

	aiCtx, err := h.contextBuilder.Build(c.Request.Context(), GetUserID(c), novelID, chapterID, cursorText)
	if err != nil {
		h.logger.Warn("failed to build AI context", zap.Int64("novel_id", novelID), zap.Error(err))
		return nil
	}

	contextStr := service.FormatContextMessages(aiCtx)
	if contextStr == "" {
		return nil
	}

	return []map[string]interface{}{
		{"role": "system", "content": "以下是当前小说的上下文信息，请在此基础上进行创作：\n" + contextStr},
	}
}

// ── Generic upstream proxy helpers ───────────────────────────────────────

// proxyJSON forwards reqBody as a JSON POST to the Python AI service at
// upstreamPath, parses the upstream JSON response and writes it back wrapped
// in the dto.APIResponse envelope. Upstream unreachability/timeout/non-2xx
// responses are mapped to 502 with a zap error log; structured upstream
// errors ({code,message} / {error} / {detail}) are passed through.
// bill=false keeps the legacy free pass-through (e.g. /api/prompt/build,
// which performs no LLM call and therefore costs nothing).
func (h *AIHandler) proxyJSON(c *gin.Context, upstreamPath string, reqBody []byte, timeout time.Duration, bill bool) {
	// M4 (task #43): AI entitlements depend only on the token balance.
	// Pre-check before spending an upstream call; 402 mirrors the frozen
	// contract message the frontend expects.
	if bill && h.tokenService != nil {
		uid := GetUserID(c)
		ok, err := h.tokenService.CanConsume(c.Request.Context(), uid, 1)
		if err != nil {
			h.logger.Error("token pre-check failed", zap.String("path", upstreamPath), zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "计费预检失败，请稍后重试"})
			return
		}
		if !ok {
			c.JSON(http.StatusPaymentRequired, dto.APIResponse{Code: 402, Message: "Token 余额不足，请充值"})
			return
		}
	}

	ctx := c.Request.Context()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	doCall := func() ([]byte, int, error) {
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, h.aiServiceURL+upstreamPath, bytes.NewReader(reqBody))
		if err != nil {
			return nil, 0, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		resp, err := h.jsonClient.Do(httpReq)
		if err != nil {
			return nil, 0, err
		}
		defer resp.Body.Close()
		body, readErr := io.ReadAll(resp.Body)
		return body, resp.StatusCode, readErr
	}

	var (
		body    []byte
		status  int
		callErr error
	)
	if h.breaker != nil {
		callErr = h.breaker.Execute(ctx, func() error {
			var execErr error
			body, status, execErr = doCall()
			return execErr
		})
	} else {
		body, status, callErr = doCall()
	}

	if callErr != nil {
		h.logger.Error("failed to call AI service",
			zap.String("path", upstreamPath),
			zap.Error(callErr),
		)
		c.JSON(http.StatusBadGateway, dto.APIResponse{
			Code:    502,
			Message: "AI service unavailable: " + callErr.Error(),
		})
		return
	}

	if status < 200 || status >= 300 {
		h.logger.Error("AI service returned error",
			zap.String("path", upstreamPath),
			zap.Int("status", status),
			zap.String("body", string(body)),
		)
		code, message := parseUpstreamError(body, status)
		c.JSON(code, dto.APIResponse{Code: code, Message: message})
		return
	}

	var data json.RawMessage
	if err := json.Unmarshal(body, &data); err != nil {
		h.logger.Error("invalid JSON from AI service",
			zap.String("path", upstreamPath),
			zap.Error(err),
		)
		c.JSON(http.StatusBadGateway, dto.APIResponse{Code: 502, Message: "invalid response from AI service"})
		return
	}

	// M4 (task #43): deduct after a successful upstream call. The response
	// body is passed through unchanged (usage rides inside it when the
	// ai-service reports it); a deduction failure never blocks delivery —
	// the upstream cost was already incurred.
	if bill && h.tokenService != nil {
		h.billProxyCall(c, upstreamPath, reqBody, body)
	}

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: data})
}

// billProxyCall parses the upstream usage block and deducts units
// (input x1 + output x2). Without a usage block a conservative fallback is
// charged and a warning is logged.
func (h *AIHandler) billProxyCall(c *gin.Context, upstreamPath string, reqBody []byte, respBody []byte) {
	uid := GetUserID(c)

	var usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	}
	var envelope struct {
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Model string `json:"model"`
	}
	hasUsage := false
	if err := json.Unmarshal(respBody, &envelope); err == nil && envelope.Usage != nil {
		usage.PromptTokens = envelope.Usage.PromptTokens
		usage.CompletionTokens = envelope.Usage.CompletionTokens
		hasUsage = true
	}

	var units int64
	if hasUsage {
		units = service.UnitsFromUsage(usage.PromptTokens, usage.CompletionTokens)
	}
	if units <= 0 {
		units = model.FallbackConsumeUnits
		if !hasUsage {
			h.logger.Warn("upstream response carries no usage block: charging conservative fallback",
				zap.String("path", upstreamPath),
				zap.Int64("units", units),
			)
		}
	}

	// Record the model actually used (task #46): prefer the model echoed by
	// the upstream response, fall back to the model requested by the client.
	var reqModel struct {
		Model string `json:"model"`
	}
	var modelPtr *string
	if envelope.Model != "" {
		modelPtr = &envelope.Model
	} else if err := json.Unmarshal(reqBody, &reqModel); err == nil && reqModel.Model != "" {
		modelPtr = &reqModel.Model
	}

	endpoint := upstreamPath
	prompt, completion := usage.PromptTokens, usage.CompletionTokens
	meta := service.ConsumeMeta{
		Reason:   model.LedgerReasonAICall,
		Model:    modelPtr,
		Endpoint: &endpoint,
	}
	if hasUsage {
		meta.PromptTokens = &prompt
		meta.CompletionTokens = &completion
	}
	if err := h.tokenService.Consume(c.Request.Context(), uid, units, meta); err != nil {
		h.logger.Warn("token deduction failed after successful AI call",
			zap.String("path", upstreamPath),
			zap.Int64("user_id", uid),
			zap.Int64("units", units),
			zap.Error(err),
		)
	}
}

// proxyBound marshals req and forwards it through proxyJSON with the default
// AI text timeout. bill toggles M4 token billing.
func (h *AIHandler) proxyBound(c *gin.Context, upstreamPath string, req interface{}, bill bool) {
	body, err := json.Marshal(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}
	h.proxyJSON(c, upstreamPath, body, aiTextTimeout, bill)
}

// parseUpstreamError extracts a structured error from an upstream non-2xx
// body. Recognized shapes: {"code":int,"message":str}, {"error":str} and
// {"detail":str}. Client-side codes (400/404/409/422) are passed through;
// anything else becomes 502.
func parseUpstreamError(body []byte, status int) (int, string) {
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Error   string          `json:"error"`
		Detail  json.RawMessage `json:"detail"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil {
		switch {
		case envelope.Message != "" && envelope.Code > 0:
			return mapUpstreamCode(envelope.Code), envelope.Message
		case envelope.Message != "":
			return mapUpstreamCode(status), envelope.Message
		case envelope.Error != "":
			return mapUpstreamCode(status), envelope.Error
		case len(envelope.Detail) > 0:
			var detailStr string
			if err := json.Unmarshal(envelope.Detail, &detailStr); err == nil && detailStr != "" {
				return mapUpstreamCode(status), detailStr
			}
			return mapUpstreamCode(status), string(envelope.Detail)
		}
	}
	msg := strings.TrimSpace(string(body))
	if msg == "" {
		msg = fmt.Sprintf("AI service error (%d)", status)
	}
	return mapUpstreamCode(status), msg
}

// mapUpstreamCode passes through client-error codes and maps everything else
// to 502 (upstream failure).
func mapUpstreamCode(code int) int {
	switch code {
	case 400, 404, 409, 422:
		return code
	default:
		return 502
	}
}

// forwardSSE POSTs reqBody to the Python AI service at upstreamPath and
// transparently streams the SSE response (data: lines) back to the client.
// The upstream request shares the gin request context, so a client disconnect
// cancels the upstream call automatically.
//
// Tech plan v2 §6.3 (M4 billing for streaming endpoints):
//   - Pre-check: the caller must hold at least the conservative fallback
//     units before we spend an upstream call (402 otherwise).
//   - Settlement: the ai-service emits a terminal `data: {"usage": {...}}`
//     meta event right before [DONE]; we parse it while forwarding, deduct
//     the real usage after the stream ends, and fall back to the
//     conservative estimate when no usage block arrives (client disconnect,
//     upstream without usage support).
func (h *AIHandler) forwardSSE(c *gin.Context, upstreamPath string, reqBody []byte) {
	uid := GetUserID(c)

	// Pre-check: refuse before spending an upstream call.
	if h.tokenService != nil {
		ok, err := h.tokenService.CanConsume(c.Request.Context(), uid, model.FallbackConsumeUnits)
		if err != nil {
			h.logger.Error("token pre-check failed (sse)", zap.String("path", upstreamPath), zap.Error(err))
			c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "计费预检失败，请稍后重试"})
			return
		}
		if !ok {
			c.JSON(http.StatusPaymentRequired, dto.APIResponse{Code: 402, Message: "Token 余额不足，请充值"})
			return
		}
	}

	httpReq, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, h.aiServiceURL+upstreamPath, bytes.NewReader(reqBody))
	if err != nil {
		h.logger.Error("failed to create upstream request",
			zap.String("path", upstreamPath),
			zap.Error(err),
		)
		h.writeSSEError(c, fmt.Sprintf("failed to create upstream request: %v", err))
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient.Do(httpReq)
	if err != nil {
		if c.Request.Context().Err() != nil {
			// Client went away — nothing to report.
			h.logger.Info("client disconnected before upstream response",
				zap.String("path", upstreamPath),
			)
			return
		}
		h.logger.Error("failed to call AI service",
			zap.String("path", upstreamPath),
			zap.Error(err),
		)
		h.writeSSEError(c, fmt.Sprintf("AI service unavailable: %v", err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		h.logger.Error("AI service returned error",
			zap.String("path", upstreamPath),
			zap.Int("status", resp.StatusCode),
			zap.String("body", string(bodyBytes)),
		)
		h.writeSSEError(c, fmt.Sprintf("AI service error (%d): %s", resp.StatusCode, string(bodyBytes)))
		return
	}

	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")

	// Stream SSE chunks from Python service to client. While forwarding we
	// capture the terminal usage meta event (v2 §6.3) for billing; the
	// usage line itself is NOT forwarded to the browser.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	var usage *sseUsage
	for scanner.Scan() {
		line := scanner.Text()

		// Intercept the billing meta event: data: {"usage": {...}}
		if u, ok := parseSSEUsageLine(line); ok {
			usage = u
			continue
		}

		// Forward SSE lines as-is (they come as "data: {...}" from Python)
		if line != "" {
			fmt.Fprintf(c.Writer, "%s\n", line)
		} else {
			// Empty line = SSE event separator
			fmt.Fprintf(c.Writer, "\n")
		}
		c.Writer.Flush()
	}

	if err := scanner.Err(); err != nil {
		if c.Request.Context().Err() != nil {
			h.logger.Info("client disconnected during SSE stream",
				zap.String("path", upstreamPath),
			)
		} else {
			h.logger.Error("error reading AI service stream",
				zap.String("path", upstreamPath),
				zap.Error(err),
			)
			// Try to send error to client
			fmt.Fprintf(c.Writer, "data: {\"content\":\"Stream error occurred\"}\n\n")
			fmt.Fprintf(c.Writer, "data: [DONE]\n\n")
			c.Writer.Flush()
		}
	}

	// Settle billing after the stream ends (success or disconnect).
	h.billSSECall(c, upstreamPath, reqBody, usage)
}

// writeSSEError emits a terminal SSE error event to the client.
func (h *AIHandler) writeSSEError(c *gin.Context, message string) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	errData, _ := json.Marshal(dto.ChatChunkData{Content: message})
	fmt.Fprintf(c.Writer, "data: %s\n\n", errData)
	fmt.Fprintf(c.Writer, "data: [DONE]\n\n")
	c.Writer.Flush()
}

// sseUsage is the terminal billing meta event emitted by the ai-service
// right before [DONE] (tech plan v2 §6.3).
type sseUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

// parseSSEUsageLine recognizes the billing meta event line
// `data: {"usage": {...}}` and returns the parsed usage. The second return
// reports whether the line was a usage event at all (even a malformed one),
// so the caller never forwards it to the browser.
func parseSSEUsageLine(line string) (*sseUsage, bool) {
	if !strings.HasPrefix(line, "data: ") {
		return nil, false
	}
	payload := strings.TrimPrefix(line, "data: ")
	if !strings.Contains(payload, "\"usage\"") {
		return nil, false
	}
	var envelope struct {
		Usage *sseUsage `json:"usage"`
	}
	if err := json.Unmarshal([]byte(payload), &envelope); err != nil || envelope.Usage == nil {
		return nil, false
	}
	return envelope.Usage, true
}

// billSSECall settles token billing after a streaming call ends. With a
// usage block the real units (input x1 + output x2) are deducted; without
// one (client disconnect, upstream without usage support) the conservative
// fallback is charged and a warning is logged. Deduction failures never
// block delivery — the upstream cost was already incurred.
func (h *AIHandler) billSSECall(c *gin.Context, upstreamPath string, reqBody []byte, usage *sseUsage) {
	if h.tokenService == nil {
		return
	}
	uid := GetUserID(c)

	var units int64
	var prompt, completion int
	if usage != nil {
		prompt, completion = usage.PromptTokens, usage.CompletionTokens
		units = service.UnitsFromUsage(prompt, completion)
	}
	if units <= 0 {
		units = model.FallbackConsumeUnits
		if usage == nil {
			h.logger.Warn("SSE stream carried no usage block: charging conservative fallback",
				zap.String("path", upstreamPath),
				zap.Int64("units", units),
			)
		}
	}

	// Record the model actually used: fall back to the requested model.
	var reqModel struct {
		Model string `json:"model"`
	}
	var modelPtr *string
	if err := json.Unmarshal(reqBody, &reqModel); err == nil && reqModel.Model != "" {
		modelPtr = &reqModel.Model
	}

	endpoint := upstreamPath
	meta := service.ConsumeMeta{
		Reason:   model.LedgerReasonAICall,
		Model:    modelPtr,
		Endpoint: &endpoint,
	}
	if usage != nil {
		meta.PromptTokens = &prompt
		meta.CompletionTokens = &completion
	}
	if err := h.tokenService.Consume(c.Request.Context(), uid, units, meta); err != nil {
		h.logger.Warn("token deduction failed after SSE stream",
			zap.String("path", upstreamPath),
			zap.Int64("user_id", uid),
			zap.Int64("units", units),
			zap.Error(err),
		)
	}
}

// truncateText truncates s to at most n runes.
func truncateText(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "……"
}

// ── Streaming handlers ───────────────────────────────────────────────────

// Chat handles POST /api/v1/ai/chat — SSE streaming chat.
// If novel_id and/or chapter_id are provided in the request, context messages are
// automatically injected so the AI is aware of the current novel state.
func (h *AIHandler) Chat(c *gin.Context) {
	var req dto.ChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if len(req.Messages) == 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: "messages cannot be empty",
		})
		return
	}

	// Build the message list to forward
	var forwardMessages []map[string]interface{}

	// Inject context messages if novel_id is provided
	if req.NovelID > 0 {
		// Use the last user message as cursor text for context building
		cursorText := ""
		for i := len(req.Messages) - 1; i >= 0; i-- {
			if req.Messages[i].Role == "user" {
				cursorText = req.Messages[i].Content
				break
			}
		}
		ctxMsgs := h.buildContextMessages(c, req.NovelID, req.ChapterID, cursorText)
		forwardMessages = append(forwardMessages, ctxMsgs...)
	}

	// Append original messages
	for _, m := range req.Messages {
		forwardMessages = append(forwardMessages, map[string]interface{}{
			"role":    m.Role,
			"content": m.Content,
		})
	}

	// Forward request to Python AI service HTTP endpoint
	proxyReq := map[string]interface{}{
		"messages": forwardMessages,
	}
	if req.Model != "" {
		proxyReq["model"] = req.Model
	}
	if req.Temperature > 0 {
		proxyReq["temperature"] = req.Temperature
	}
	if req.MaxTokens > 0 {
		proxyReq["max_tokens"] = req.MaxTokens
	}

	body, err := json.Marshal(proxyReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}

	h.forwardSSE(c, "/api/chat/stream", body)
}

// Inline handles POST /api/v1/ai/inline — SSE streaming inline completion.
// It binds the editor-side fields (preceding/following text, cursor position),
// injects novel context when available and forwards to the Python
// /api/chat/inline SSE endpoint.
func (h *AIHandler) Inline(c *gin.Context) {
	var req dto.InlineRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	h.logger.Info("inline completion requested",
		zap.Int64("novel_id", req.NovelID),
		zap.Int64("chapter_id", req.ChapterID),
		zap.Int("cursor_position", req.CursorPosition),
	)

	var messages []map[string]interface{}
	if ctxMsgs := h.buildContextMessages(c, req.NovelID, req.ChapterID, req.PrecedingText); len(ctxMsgs) > 0 {
		messages = append(messages, ctxMsgs...)
	}

	userContent := "前文：\n" + truncateText(req.PrecedingText, inlineContextMaxChars) + "\n\n请从这里自然地续写后续内容。"
	if req.FollowingText != "" {
		userContent += "\n\n续写时需要衔接的后文：\n" + truncateText(req.FollowingText, inlineContextMaxChars)
	}

	messages = append(messages,
		map[string]interface{}{
			"role":    "system",
			"content": "你是一个小说续写助手。请根据给定的前文续写后续内容。只输出续写的正文，不要重复前文，不要输出任何解释或标题。",
		},
		map[string]interface{}{"role": "user", "content": userContent},
	)

	body, err := json.Marshal(map[string]interface{}{"messages": messages})
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}

	h.forwardSSE(c, "/api/chat/inline", body)
}

// Rewrite handles POST /api/v1/ai/rewrite — SSE streaming rewrite of selected
// text (polish/expand/condense/humanize). It forwards to the Python
// /api/chat/rewrite SSE endpoint.
func (h *AIHandler) Rewrite(c *gin.Context) {
	var req dto.RewriteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	actionInstructions := map[string]string{
		"polish":   "润色下面的文字：保持原意，优化文笔与表达。",
		"expand":   "扩写下面的文字：保持原意，补充细节与描写，使内容更丰满。",
		"condense": "精简下面的文字：保持原意，删减冗余，使表达更凝练。",
		"humanize": "改写下面的文字：使其更自然、更口语化，去除机械感。",
	}
	instruction, ok := actionInstructions[req.Action]
	if !ok {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: "action must be one of: polish, expand, condense, humanize",
		})
		return
	}

	h.logger.Info("rewrite requested",
		zap.Int64("novel_id", req.NovelID),
		zap.Int64("chapter_id", req.ChapterID),
		zap.String("action", req.Action),
	)

	var messages []map[string]interface{}
	if ctxMsgs := h.buildContextMessages(c, req.NovelID, req.ChapterID, req.SelectedText); len(ctxMsgs) > 0 {
		messages = append(messages, ctxMsgs...)
	}

	messages = append(messages,
		map[string]interface{}{
			"role":    "system",
			"content": "你是一个小说文本改写助手。" + instruction + "只输出改写后的正文，不要输出任何解释。",
		},
		map[string]interface{}{"role": "user", "content": req.SelectedText},
	)

	body, err := json.Marshal(map[string]interface{}{"messages": messages})
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}

	h.forwardSSE(c, "/api/chat/rewrite", body)
}

// ── Non-streaming thin proxies ───────────────────────────────────────────

// Candidates handles POST /api/v1/ai/candidates — AI candidate text generation.
func (h *AIHandler) Candidates(c *gin.Context) {
	var req dto.CandidatesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	if req.N <= 0 {
		req.N = 3
	}
	h.logger.Info("candidates requested", zap.String("action", req.Action), zap.Int("n", req.N))
	h.proxyBound(c, "/api/ai/candidates", req, true)
}

// Review handles POST /api/v1/ai/review — AI annotation review of chapter text.
func (h *AIHandler) Review(c *gin.Context) {
	var req dto.ReviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("review requested", zap.Int64("chapter_id", req.ChapterID))
	h.proxyBound(c, "/api/ai/review", req, true)
}

// Inspiration handles POST /api/v1/ai/inspiration — AI inspiration suggestions.
func (h *AIHandler) Inspiration(c *gin.Context) {
	var req dto.InspirationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("inspiration requested", zap.String("category", req.Category))
	h.proxyBound(c, "/api/ai/inspiration", req, true)
}

// AnalyzeStory handles POST /api/v1/ai/analyze-story — whole-story analysis report.
func (h *AIHandler) AnalyzeStory(c *gin.Context) {
	var req dto.AnalyzeStoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("analyze-story requested", zap.String("title", req.Title))
	h.proxyBound(c, "/api/ai/analyze-story", req, true)
}

// AnalyzeMedia handles POST /api/v1/ai/analyze-media — media content analysis report.
func (h *AIHandler) AnalyzeMedia(c *gin.Context) {
	var req dto.AnalyzeMediaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("analyze-media requested", zap.String("title", req.Title), zap.String("platform", req.Platform))
	h.proxyBound(c, "/api/ai/analyze-media", req, true)
}

// ExpandOutline handles POST /api/v1/ai/expand-outline — expand an outline node into a draft.
func (h *AIHandler) ExpandOutline(c *gin.Context) {
	var req dto.ExpandOutlineRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("expand-outline requested",
		zap.String("outline_title", req.OutlineTitle),
		zap.Int("target_words", req.TargetWords),
	)
	h.proxyBound(c, "/api/ai/expand-outline", req, true)
}

// GenerateTitles handles POST /api/v1/ai/generate-titles — media title generation.
func (h *AIHandler) GenerateTitles(c *gin.Context) {
	var req dto.GenerateTitlesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	if req.Count <= 0 {
		req.Count = 8
	}
	h.logger.Info("generate-titles requested", zap.String("platform", req.Platform), zap.Int("count", req.Count))
	h.proxyBound(c, "/api/ai/generate-titles", req, true)
}

// AdaptContent handles POST /api/v1/ai/adapt-content — adapt content for a platform.
func (h *AIHandler) AdaptContent(c *gin.Context) {
	var req dto.AdaptContentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("adapt-content requested", zap.String("platform", req.Platform))
	h.proxyBound(c, "/api/ai/adapt-content", req, true)
}

// StoryOverview handles POST /api/v1/ai/story-overview — AI generation of the
// work-overview fields (title/description/logline/style/audience/intent).
// The full existing overview rides along as context so single-field
// generation stays consistent with the whole picture; a random variant is
// injected upstream for diversity (popularity + innovation enforced in the
// upstream prompt).
func (h *AIHandler) StoryOverview(c *gin.Context) {
	var req dto.StoryOverviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("story-overview requested", zap.Strings("fields", req.Fields))
	// 推理模型（deepseek-v4-flash）reasoning 耗时长，且空 content / 空解析
	// 结果时上游最多换变体重试 3 次 —— 默认 60s aiTextTimeout 不够。140s
	// 仍低于 jsonClient 的 150s 硬顶兜底。
	body, err := json.Marshal(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}
	h.proxyJSON(c, "/api/ai/story-overview", body, 140*time.Second, true)
}

// PromptBuild handles POST /api/v1/prompt/build — build context-aware prompt messages.
func (h *AIHandler) PromptBuild(c *gin.Context) {
	var req dto.PromptBuildRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("prompt build requested", zap.String("type", req.Type))
	// /api/prompt/build performs no LLM call — never billed (bill=false).
	h.proxyBound(c, "/api/prompt/build", req, false)
}

// agentScenes is the whitelist of agent generation scenes.
var agentScenes = map[string]bool{
	"character":   true,
	"setting":     true,
	"summary":     true,
	"inspiration": true,
	"outline":     true,
	"chapter":     true,
}

// AgentGenerate handles POST /api/v1/ai/agent/generate — assembles the
// novel context server-side (outline / chapter-locked memory / preceding
// chapters) and thin-proxies the frozen payload to the Python
// /api/agents/generate endpoint.
func (h *AIHandler) AgentGenerate(c *gin.Context) {
	var req dto.AgentGenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	if !agentScenes[req.Scene] {
		c.JSON(http.StatusBadRequest, dto.APIResponse{
			Code:    400,
			Message: "scene must be one of: character, setting, summary, inspiration, outline, chapter",
		})
		return
	}
	if h.agentContext == nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "agent context service not configured"})
		return
	}

	h.logger.Info("agent generate requested",
		zap.Int64("novel_id", req.NovelID),
		zap.String("scene", req.Scene),
	)

	payload, err := h.agentContext.BuildAgentContext(c.Request.Context(), GetUserID(c), req.NovelID, req.Scene, req.ItemID, req.NodeID, req.Instruction)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "novel not found"})
			return
		}
		h.logger.Error("failed to build agent context",
			zap.Int64("novel_id", req.NovelID),
			zap.Error(err),
		)
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to build agent context"})
		return
	}

	body, err := json.Marshal(payload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}
	h.proxyJSON(c, "/api/agents/generate", body, aiTextTimeout, true)
}

// GenerateImagePrompt handles POST /api/v1/aigc/prompt — 图片 Prompt 自动预制。
// It fetches chapter context and calls the Python /api/prompt/image endpoint to
// convert Chinese novel text into an English image generation prompt.
func (h *AIHandler) GenerateImagePrompt(c *gin.Context) {
	var req dto.ImagePromptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	contextText := req.ContextText

	// If context_text is empty but chapter_id is provided, build context via AIContextBuilder
	if contextText == "" && req.NovelID > 0 && req.ChapterID > 0 {
		aiCtx, err := h.contextBuilder.Build(c.Request.Context(), GetUserID(c), req.NovelID, req.ChapterID, "")
		if err != nil {
			h.logger.Warn("failed to build context for image prompt", zap.Error(err))
		}
		if aiCtx != nil && aiCtx.ChapterContent != "" {
			contextText = aiCtx.ChapterContent
		}
	}

	if contextText == "" {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "context_text is required or provide novel_id + chapter_id"})
		return
	}

	style := req.Style
	if style == "" {
		style = "realistic"
	}

	// Call Python AI service /api/prompt/image
	pythonReq := map[string]interface{}{
		"context_text": contextText,
		"novel_genre":  req.NovelGenre,
		"style":        style,
	}
	bodyBytes, err := json.Marshal(pythonReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to marshal request"})
		return
	}

	h.proxyJSON(c, "/api/prompt/image", bodyBytes, aiTextTimeout, true)
}
