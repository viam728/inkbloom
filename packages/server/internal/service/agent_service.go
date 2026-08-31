package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"go.uber.org/zap"
)

// AgentTool is one function-calling tool exposed to the conversational
// creation Agent. Serialized in OpenAI tool format:
// {"type":"function","function":{"name":...,"description":...,"parameters":...}}.
type AgentTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

// agentToolCall is one tool invocation requested by the LLM.
type agentToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// AgentService drives the conversational creation Agent loop. It exposes a
// small set of creation tools (create_novel / create_chapter / write_chapter /
// list_novels) and iterates with the LLM: execute tool calls until the model
// returns a final natural-language answer.
type AgentService struct {
	novelSvc     *NovelService
	chapterSvc   *ChapterService
	agentContext *AgentContextService
	aiServiceURL string
	httpClient   *http.Client
	logger       *zap.Logger
}

// NewAgentService creates a new AgentService.
func NewAgentService(
	novelSvc *NovelService,
	chapterSvc *ChapterService,
	agentContext *AgentContextService,
	aiServiceURL string,
	logger *zap.Logger,
) *AgentService {
	return &AgentService{
		novelSvc:     novelSvc,
		chapterSvc:   chapterSvc,
		agentContext: agentContext,
		aiServiceURL: strings.TrimRight(aiServiceURL, "/"),
		httpClient:   &http.Client{Timeout: 5 * time.Minute},
		logger:       logger,
	}
}

// toolSchema returns the function-calling tool definitions exposed to the LLM.
func (s *AgentService) toolSchema() []AgentTool {
	ft := func(name, desc string, params map[string]any) AgentTool {
		t := AgentTool{Type: "function"}
		t.Function.Name = name
		t.Function.Description = desc
		t.Function.Parameters = params
		return t
	}
	return []AgentTool{
		ft("create_novel", "创建一部新小说作品。用户想开始写新书时调用。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":       map[string]any{"type": "string", "description": "书名"},
				"genre":       map[string]any{"type": "string", "description": "题材/类型（如武侠、都市、科幻）"},
				"description": map[string]any{"type": "string", "description": "一句话简介/故事梗概"},
			},
			"required": []string{"title"},
		}),
		ft("create_chapter", "在指定小说下新建一个章节骨架（标题），不写正文。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"title":    map[string]any{"type": "string", "description": "章节标题"},
			},
			"required": []string{"novel_id", "title"},
		}),
		ft("write_chapter", "为指定章节撰写正文并保存。调用前章节需已存在（先 create_chapter）。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id":    map[string]any{"type": "integer", "description": "小说 ID"},
				"chapter_id":  map[string]any{"type": "integer", "description": "章节 ID"},
				"instruction": map[string]any{"type": "string", "description": "本章要写什么（情节要求）"},
			},
			"required": []string{"novel_id", "chapter_id"},
		}),
		ft("list_novels", "列出用户的作品列表。用户询问已有哪些作品时调用。", map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}),
	}
}

// systemPrompt is the Agent's persona + tool-usage rule.
const agentSystemPrompt = "你是 InkBloom 的创作 Agent，帮助用户创作小说。" +
	"你可以调用工具（create_novel / create_chapter / write_chapter / list_novels）" +
	"来实际创建作品、章节并撰写正文。执行工具后，用简洁中文向用户汇报结果。" +
	"当用户想开始创作时，主动调用工具完成任务，而不是只给建议。"

// Run executes one Agent turn: given the conversation messages, it loops with
// the LLM (execute tool calls, feed results back) until the model returns a
// final answer. Returns the final answer text and the executed tool summary.
func (s *AgentService) Run(ctx context.Context, userID int64, messages []map[string]string) (string, []map[string]any, error) {
	msgs := make([]map[string]any, 0, len(messages)+1)
	msgs = append(msgs, map[string]any{"role": "system", "content": agentSystemPrompt})
	for _, m := range messages {
		msgs = append(msgs, map[string]any{"role": m["role"], "content": m["content"]})
	}

	var executed []map[string]any
	const maxSteps = 6
	for step := 0; step < maxSteps; step++ {
		resp, err := s.callLLM(ctx, msgs)
		if err != nil {
			return "", executed, err
		}

		if len(resp.ToolCalls) == 0 {
			if resp.Content == "" {
				return "（Agent 未返回内容）", executed, nil
			}
			return resp.Content, executed, nil
		}

		for _, tc := range resp.ToolCalls {
			result := s.executeTool(ctx, userID, tc)
			executed = append(executed, map[string]any{
				"tool":   tc.Name,
				"args":   tc.Arguments,
				"result": result,
			})
			assistantMsg := map[string]any{
				"role":    "assistant",
				"content": "",
				"tool_calls": []map[string]any{{
					"id":   tc.ID,
					"type": "function",
					"function": map[string]any{
						"name":      tc.Name,
						"arguments": tc.Arguments,
					},
				}},
			}
			// DeepSeek thinking mode: echo reasoning_content back verbatim.
			if resp.ReasoningContent != "" {
				assistantMsg["reasoning_content"] = resp.ReasoningContent
			}
			msgs = append(msgs, assistantMsg)
			msgs = append(msgs, map[string]any{
				"role":         "tool",
				"tool_call_id": tc.ID,
				"content":      result,
			})
		}
	}

	return "（Agent 执行步骤过多，已停止）", executed, nil
}

// llmResponse is the decoded /api/agent/chat response.
type llmResponse struct {
	Content          string          `json:"content"`
	ReasoningContent string          `json:"reasoning_content"`
	ToolCalls        []agentToolCall `json:"tool_calls"`
}

// callLLM performs one tool-calling LLM request.
func (s *AgentService) callLLM(ctx context.Context, messages []map[string]any) (*llmResponse, error) {
	body, _ := json.Marshal(map[string]any{
		"messages": messages,
		"tools":    s.toolSchema(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.aiServiceURL+"/api/agent/chat", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(raw))
	}
	var out llmResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// executeTool dispatches a tool call to the real service layer and returns a
// compact JSON result string fed back to the LLM.
func (s *AgentService) executeTool(ctx context.Context, userID int64, tc agentToolCall) string {
	var args map[string]any
	if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
		args = map[string]any{}
	}
	asJSON := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			return "{}"
		}
		return string(b)
	}

	switch tc.Name {
	case "create_novel":
		title, _ := args["title"].(string)
		genre, _ := args["genre"].(string)
		desc, _ := args["description"].(string)
		if title == "" {
			return `{"error":"title 必填"}`
		}
		novel, err := s.novelSvc.CreateNovel(ctx, userID, &dto.CreateNovelRequest{
			Title:       title,
			Genre:       genre,
			Description: desc,
		})
		if err != nil {
			s.logger.Warn("agent create_novel failed", zap.Error(err))
			return `{"error":"创建失败"}`
		}
		return asJSON(map[string]any{"novel_id": novel.ID, "title": novel.Title})

	case "create_chapter":
		nid, _ := args["novel_id"].(float64)
		title, _ := args["title"].(string)
		if title == "" {
			return `{"error":"title 必填"}`
		}
		ch, err := s.chapterSvc.CreateChapter(ctx, userID, &dto.CreateChapterRequest{
			NovelID: int64(nid),
			Title:   title,
		})
		if err != nil {
			s.logger.Warn("agent create_chapter failed", zap.Error(err))
			return `{"error":"创建章节失败"}`
		}
		return asJSON(map[string]any{"chapter_id": ch.ID, "title": ch.Title})

	case "write_chapter":
		nid, _ := args["novel_id"].(float64)
		cid, _ := args["chapter_id"].(float64)
		instr, _ := args["instruction"].(string)
		return s.writeChapter(ctx, userID, int64(nid), int64(cid), instr)

	case "list_novels":
		list, err := s.novelSvc.ListNovels(ctx, userID, 1, 50)
		if err != nil {
			s.logger.Warn("agent list_novels failed", zap.Error(err))
			return `{"error":"列出失败"}`
		}
		items := make([]map[string]any, 0, len(list.Novels))
		for _, n := range list.Novels {
			items = append(items, map[string]any{"novel_id": n.ID, "title": n.Title})
		}
		return asJSON(map[string]any{"novels": items})

	default:
		return `{"error":"未知工具: ` + tc.Name + `"}`
	}
}

// writeChapter generates chapter body via the chapter agent scene and saves it.
func (s *AgentService) writeChapter(ctx context.Context, userID, novelID, chapterID int64, instruction string) string {
	if instruction == "" {
		instruction = "请完整撰写本章正文。"
	}
	payload, err := s.agentContext.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, instruction)
	if err != nil {
		return `{"error":"构建上下文失败"}`
	}
	var out struct {
		Content string `json:"content"`
		Error   string `json:"error"`
	}
	if err := s.postAI(ctx, "/api/agents/generate", payload, &out); err != nil {
		return `{"error":"生成失败"}`
	}
	if out.Error != "" {
		return `{"error":"` + out.Error + `"}`
	}
	if strings.TrimSpace(out.Content) == "" {
		return `{"error":"生成内容为空"}`
	}
	content := out.Content
	if _, err := s.chapterSvc.UpdateChapter(ctx, userID, chapterID, &dto.UpdateChapterRequest{
		Content: &content,
	}); err != nil {
		return `{"error":"保存章节失败"}`
	}
	b, _ := json.Marshal(map[string]any{"chapter_id": chapterID, "written": len([]rune(content))})
	return string(b)
}

// postAI forwards a JSON payload to the ai-service and decodes the response.
func (s *AgentService) postAI(ctx context.Context, path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.aiServiceURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(raw))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
