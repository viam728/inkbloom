package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
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
	breaker        *breaker.Breaker // optional circuit breaker guarding non-streaming upstream calls
}

// AIHandlerOption customizes an AIHandler constructed by NewAIHandler.
type AIHandlerOption func(*AIHandler)

// WithAIBreaker attaches a circuit breaker that guards non-streaming
// upstream JSON calls (proxyJSON). Streaming calls are not breaker-guarded.
func WithAIBreaker(cb *breaker.Breaker) AIHandlerOption {
	return func(h *AIHandler) { h.breaker = cb }
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
			Timeout: aiTextTimeout,
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

	aiCtx, err := h.contextBuilder.Build(c.Request.Context(), novelID, chapterID, cursorText)
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
func (h *AIHandler) proxyJSON(c *gin.Context, upstreamPath string, reqBody []byte, timeout time.Duration) {
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

	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: data})
}

// proxyBound marshals req and forwards it through proxyJSON with the default
// AI text timeout.
func (h *AIHandler) proxyBound(c *gin.Context, upstreamPath string, req interface{}) {
	body, err := json.Marshal(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{
			Code:    500,
			Message: fmt.Sprintf("failed to marshal request: %v", err),
		})
		return
	}
	h.proxyJSON(c, upstreamPath, body, aiTextTimeout)
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
func (h *AIHandler) forwardSSE(c *gin.Context, upstreamPath string, reqBody []byte) {
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

	// Stream SSE chunks from Python service to client
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()

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
			return
		}
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
	h.proxyBound(c, "/api/ai/candidates", req)
}

// Review handles POST /api/v1/ai/review — AI annotation review of chapter text.
func (h *AIHandler) Review(c *gin.Context) {
	var req dto.ReviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("review requested", zap.Int64("chapter_id", req.ChapterID))
	h.proxyBound(c, "/api/ai/review", req)
}

// Inspiration handles POST /api/v1/ai/inspiration — AI inspiration suggestions.
func (h *AIHandler) Inspiration(c *gin.Context) {
	var req dto.InspirationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("inspiration requested", zap.String("category", req.Category))
	h.proxyBound(c, "/api/ai/inspiration", req)
}

// AnalyzeStory handles POST /api/v1/ai/analyze-story — whole-story analysis report.
func (h *AIHandler) AnalyzeStory(c *gin.Context) {
	var req dto.AnalyzeStoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("analyze-story requested", zap.String("title", req.Title))
	h.proxyBound(c, "/api/ai/analyze-story", req)
}

// AnalyzeMedia handles POST /api/v1/ai/analyze-media — media content analysis report.
func (h *AIHandler) AnalyzeMedia(c *gin.Context) {
	var req dto.AnalyzeMediaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("analyze-media requested", zap.String("title", req.Title), zap.String("platform", req.Platform))
	h.proxyBound(c, "/api/ai/analyze-media", req)
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
	h.proxyBound(c, "/api/ai/expand-outline", req)
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
	h.proxyBound(c, "/api/ai/generate-titles", req)
}

// AdaptContent handles POST /api/v1/ai/adapt-content — adapt content for a platform.
func (h *AIHandler) AdaptContent(c *gin.Context) {
	var req dto.AdaptContentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("adapt-content requested", zap.String("platform", req.Platform))
	h.proxyBound(c, "/api/ai/adapt-content", req)
}

// PromptBuild handles POST /api/v1/prompt/build — build context-aware prompt messages.
func (h *AIHandler) PromptBuild(c *gin.Context) {
	var req dto.PromptBuildRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: fmt.Sprintf("invalid request: %v", err)})
		return
	}
	h.logger.Info("prompt build requested", zap.String("type", req.Type))
	h.proxyBound(c, "/api/prompt/build", req)
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
		aiCtx, err := h.contextBuilder.Build(c.Request.Context(), req.NovelID, req.ChapterID, "")
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

	h.proxyJSON(c, "/api/prompt/image", bodyBytes, aiTextTimeout)
}
