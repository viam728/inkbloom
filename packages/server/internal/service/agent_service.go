package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	docSvc       *NovelDocService
	agentContext *AgentContextService
	aiServiceURL string
	httpClient   *http.Client
	logger       *zap.Logger
}

// NewAgentService creates a new AgentService.
func NewAgentService(
	novelSvc *NovelService,
	chapterSvc *ChapterService,
	docSvc *NovelDocService,
	agentContext *AgentContextService,
	aiServiceURL string,
	logger *zap.Logger,
) *AgentService {
	return &AgentService{
		novelSvc:     novelSvc,
		chapterSvc:   chapterSvc,
		docSvc:       docSvc,
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
		ft("create_chapter", "在指定小说下新建一个章节骨架（标题），不写正文。章节会自动挂到大纲：有同名要点则绑定为该要点正文，否则在末幕追加新要点。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"title":    map[string]any{"type": "string", "description": "章节标题"},
			},
			"required": []string{"novel_id", "title"},
		}),
		ft("write_chapter", "为指定章节撰写正文并保存。调用前章节需已存在（先 create_chapter）。mode 可选：replace（默认，整章重写）/ append（续写，追加到已有正文之后）/ merge（扩写，基于已有正文重写一版更完整的）。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id":    map[string]any{"type": "integer", "description": "小说 ID"},
				"chapter_id":  map[string]any{"type": "integer", "description": "章节 ID"},
				"instruction": map[string]any{"type": "string", "description": "本章要写什么（情节要求）"},
				"mode":        map[string]any{"type": "string", "enum": []string{"replace", "append", "merge"}, "description": "写入模式：replace 整章重写（默认）/ append 续写追加 / merge 扩写重写"},
			},
			"required": []string{"novel_id", "chapter_id"},
		}),
		ft("list_novels", "列出用户的作品列表。用户询问已有哪些作品时调用。", map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}),
		ft("save_memory", "把生成/提取的角色、设定、地点等记忆项写入作品的记忆模块（novel_memory）。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"items": map[string]any{
					"type": "array",
					"description": "记忆项列表。每项含 type（character/setting/location 等）、name、content、fields（可省略）",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"type":    map[string]any{"type": "string"},
							"name":    map[string]any{"type": "string"},
							"content": map[string]any{"type": "string"},
							"fields":  map[string]any{"type": "object"},
						},
					},
				},
			},
			"required": []string{"novel_id", "items"},
		}),
		ft("save_outline", "把生成的大纲（幕/节点结构）写入作品的大纲模块（novel_outline）。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"acts": map[string]any{
					"type": "array",
					"description": "大纲幕结构。每幕含 title 与 nodes（每节点含 title/summary）",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"title": map[string]any{"type": "string"},
							"nodes": map[string]any{"type": "array"},
						},
					},
				},
			},
			"required": []string{"novel_id", "acts"},
		}),
		ft("list_chapters", "列出某部小说的全部章节（chapter_id + title），写章节前先确认正确的 chapter_id，避免误建章节。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
			},
			"required": []string{"novel_id"},
		}),
		ft("get_chapter_by_title", "按标题或关键词查找章节，返回匹配的 chapter_id 与 title；找不到返回 found:false。用于把用户口述的'第N章/某章'解析成真实 chapter_id。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"title":    map[string]any{"type": "string", "description": "章节标题或关键词（可含'第N章'/'《》'等）"},
			},
			"required": []string{"novel_id", "title"},
		}),
	}
}

// systemPrompt is the Agent's persona + tool-usage rule.
const agentSystemPrompt = "你是 InkBloom 的创作 Agent，帮助用户创作小说。" +
	"你可以调用工具（create_novel / create_chapter / write_chapter / list_novels / list_chapters / get_chapter_by_title / save_memory / save_outline）" +
	"来实际创建作品、章节、撰写正文，并把角色/设定写入记忆模块、把情节规划写入大纲模块。" +
	"章节正文统一在大纲中管理：create_chapter 新建的章节会自动挂到大纲（同名要点绑定，否则末幕追加新要点），" +
	"因此规划整本书时优先 save_outline 生成幕/要点结构，再逐章 create_chapter + write_chapter，章节即可落到对应要点上。" +
	"执行工具后，用简洁中文向用户汇报结果。" +
	"当用户想开始创作时，主动调用工具完成任务，而不是只给建议。" +
	"当用户用'第N章/某章'口吻指代章节时，先调用 list_chapters 或 get_chapter_by_title 解析出真实 chapter_id，再 write_chapter；不要凭空新建章节。"

// Run executes one Agent turn: given the conversation messages, it loops with
// the LLM (execute tool calls, feed results back) until the model returns a
// final answer. Returns the final answer text and the executed tool summary.
// novelID is the author's currently-selected work (0 when none): create/write
// tools fall back to it so the Agent never drafts without a target work.
func (s *AgentService) Run(ctx context.Context, userID int64, novelID int64, messages []map[string]any) (string, []map[string]any, error) {
	msgs := make([]map[string]any, 0, len(messages)+1)
	sys := agentSystemPrompt
	if novelID > 0 {
		sys += fmt.Sprintf(" 用户当前正在编辑的作品 ID 是 %d；若用户未明确指定作品，创建章节/撰写正文默认作用于该作品。", novelID)
	}
	msgs = append(msgs, map[string]any{"role": "system", "content": sys})
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

		// Build ONE assistant message carrying every tool call returned this
		// turn (the standard OpenAI/DeepSeek shape), and echo reasoning_content
		// back exactly once for DeepSeek thinking mode. Spawning a separate
		// assistant message per tool call (old behaviour) duplicated
		// reasoning_content across messages and is not accepted by all models.
		assistantMsg := map[string]any{
			"role":      "assistant",
			"content":   "",
			"tool_calls": make([]map[string]any, 0, len(resp.ToolCalls)),
		}
		for _, tc := range resp.ToolCalls {
			assistantMsg["tool_calls"] = append(assistantMsg["tool_calls"].([]map[string]any), map[string]any{
				"id":   tc.ID,
				"type": "function",
				"function": map[string]any{
					"name":      tc.Name,
					"arguments": tc.Arguments,
				},
			})
		}
		if resp.ReasoningContent != "" {
			assistantMsg["reasoning_content"] = resp.ReasoningContent
		}
		msgs = append(msgs, assistantMsg)
		for _, tc := range resp.ToolCalls {
			result := s.executeTool(ctx, userID, novelID, tc)
			executed = append(executed, map[string]any{
				"tool":   tc.Name,
				"args":   tc.Arguments,
				"result": result,
			})
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
// compact JSON result string fed back to the LLM. novelID is the author's
// current work; create/write tools fall back to it when the LLM omits novel_id.
func (s *AgentService) executeTool(ctx context.Context, userID int64, novelID int64, tc agentToolCall) string {
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
	// resolveNovelID returns the target novel: explicit arg > current work.
	resolveNovelID := func() int64 {
		if n, ok := args["novel_id"].(float64); ok && n > 0 {
			return int64(n)
		}
		return novelID
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
		nid := resolveNovelID()
		title, _ := args["title"].(string)
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		if title == "" {
			return `{"error":"title 必填"}`
		}
		// R2 guardrail (§七.3.5a): do not create a twin chapter when an
		// existing one already has the same normalized title. Resolve and
		// return it with a warning instead of silently duplicating.
		existingList, lerr := s.chapterSvc.ListChaptersByNovel(ctx, userID, nid)
		if lerr != nil {
			s.logger.Warn("agent create_chapter dedupe lookup failed", zap.Error(lerr))
		} else {
			key := chapterTitleKey(title)
			for _, e := range existingList {
				if chapterTitleKey(e.Title) == key {
					return asJSON(map[string]any{
						"chapter_id": e.ID,
						"title":      e.Title,
						"warning":    "已存在同名章节，未新建",
					})
				}
			}
		}
		ch, err := s.chapterSvc.CreateChapter(ctx, userID, &dto.CreateChapterRequest{
			NovelID: nid,
			Title:   title,
		})
		if err != nil {
			s.logger.Warn("agent create_chapter failed", zap.Error(err))
			return `{"error":"创建章节失败"}`
		}
		// 文章库并入大纲：Agent 新建的章节自动挂到大纲（同名要点绑定，
		// 无匹配则追加新要点），保证章节在大纲管理中可达。Best-effort。
		s.docSvc.BindChapterToOutline(ctx, userID, nid, ch.ID, ch.Title, false)
		return asJSON(map[string]any{"chapter_id": ch.ID, "title": ch.Title})

	case "write_chapter":
		nid := resolveNovelID()
		cid, _ := args["chapter_id"].(float64)
		instr, _ := args["instruction"].(string)
		mode, _ := args["mode"].(string)
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		return s.writeChapter(ctx, userID, nid, int64(cid), instr, mode)

	case "save_memory":
		nid := resolveNovelID()
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）"}`
		}
		if raw, ok := args["items"].([]interface{}); ok {
			count, err := s.syncMemory(ctx, userID, nid, raw)
			if err != nil {
				s.logger.Warn("agent save_memory failed", zap.Error(err))
				return `{"error":"保存记忆失败"}`
			}
			return asJSON(map[string]any{"saved": count})
		}
		return `{"error":"items 必填"}`

	case "save_outline":
		nid := resolveNovelID()
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）"}`
		}
		if raw, ok := args["acts"].([]interface{}); ok {
			cnt, err := s.syncOutline(ctx, userID, nid, raw)
			if err != nil {
				s.logger.Warn("agent save_outline failed", zap.Error(err))
				return `{"error":"保存大纲失败"}`
			}
			return asJSON(map[string]any{"acts": cnt})
		}
		return `{"error":"acts 必填"}`

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

	case "list_chapters":
		nid := resolveNovelID()
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		list, err := s.chapterSvc.ListChaptersByNovel(ctx, userID, nid)
		if err != nil {
			s.logger.Warn("agent list_chapters failed", zap.Error(err))
			return `{"error":"列出章节失败"}`
		}
		items := make([]map[string]any, 0, len(list))
		for _, c := range list {
			items = append(items, map[string]any{"chapter_id": c.ID, "title": c.Title})
		}
		return asJSON(map[string]any{"chapters": items})

	case "get_chapter_by_title":
		nid := resolveNovelID()
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		title, _ := args["title"].(string)
		if title == "" {
			return `{"error":"title 必填"}`
		}
		ch, err := s.chapterSvc.GetChapterByTitle(ctx, userID, nid, title)
		if err != nil {
			s.logger.Warn("agent get_chapter_by_title failed", zap.Error(err))
			return `{"error":"查找章节失败"}`
		}
		if ch == nil {
			return asJSON(map[string]any{"found": false})
		}
		return asJSON(map[string]any{"found": true, "chapter_id": ch.ID, "title": ch.Title})

	default:
		return `{"error":"未知工具: ` + tc.Name + `"}`
	}
}

// writeChapter generates chapter body via the chapter agent scene and saves it.
// mode selects replace (default, whole-chapter rewrite), append (continue and
// append after existing text) or merge (expand/rewrite a fuller version on top
// of the existing text).
func (s *AgentService) writeChapter(ctx context.Context, userID, novelID, chapterID int64, instruction, mode string) string {
	// B4 guardrail: verify the chapter exists BEFORE spending an LLM call, and
	// reuse the fetched content for append/merge below. A wrong chapter_id now
	// fails fast instead of burning a generation and only then erroring.
	existing, gerr := s.chapterSvc.GetChapter(ctx, userID, chapterID)
	if gerr != nil {
		if errors.Is(gerr, ErrNotFound) {
			return fmt.Sprintf(`{"error":"章节 ID %d 不存在，请先用 list_chapters 查询并传入正确的 chapter_id，不要新建章节"}`, chapterID)
		}
		return `{"error":"查询章节失败"}`
	}

	// Guard (plan §七.3.1 "写前自动快照"): capture current content before the
	// Agent overwrites it, so the pre-write text is always recoverable.
	// Best-effort — failures are swallowed inside SnapshotForAgent.
	s.chapterSvc.SnapshotForAgent(ctx, userID, chapterID)

	// B3 write mode: append/merge carry the existing text into the prompt so the
	// model continues/expands instead of rewriting from scratch, and append
	// concatenates the result onto the prior text rather than replacing it.
	existingText := existing.Content
	switch mode {
	case "append":
		if instruction == "" {
			instruction = "请接着本章已有正文续写接下来的内容。"
		}
		if strings.TrimSpace(existingText) != "" {
			instruction += "\n\n【续写要求】以下是本章已有正文，请在结尾之后接着续写，不要重复已有内容：\n" + existingText
		}
	case "merge":
		if instruction == "" {
			instruction = "请在本章已有正文基础上扩写，保留情节与设定，输出一版更完整的正文。"
		}
		if strings.TrimSpace(existingText) != "" {
			instruction += "\n\n【扩写要求】以下是本章已有正文，请在此基础上扩写/润色成一版更完整的内容，保持情节一致：\n" + existingText
		}
	default: // replace
		if instruction == "" {
			instruction = "请完整撰写本章正文。"
		}
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
	// append concatenates the continuation onto the existing text; replace/merge
	// store the (full) generated content verbatim.
	if mode == "append" && strings.TrimSpace(existingText) != "" {
		content = existingText + "\n\n" + content
	}
	if _, err := s.chapterSvc.UpdateChapter(ctx, userID, chapterID, &dto.UpdateChapterRequest{
		Content: &content,
	}); err != nil {
		return `{"error":"保存章节失败"}`
	}
	// B7 变更摘要：before/after 字数供前端在 AI 消息里展示改写范围。
	b, _ := json.Marshal(map[string]any{
		"chapter_id":   chapterID,
		"written":      len([]rune(content)),
		"before_chars": len([]rune(existingText)),
		"after_chars":  len([]rune(content)),
	})
	return string(b)
}

// syncMemory merges LLM-provided memory items into the novel's memory module
// (novel_memory). Existing items are preserved; new items are appended by
// name-dedup so re-running never duplicates.
func (s *AgentService) syncMemory(ctx context.Context, userID, novelID int64, rawItems []interface{}) (int, error) {
	// Read current doc (empty when none).
	current, err := s.docSvc.GetMemory(ctx, userID, novelID)
	if err != nil {
		return 0, err
	}
	var existingItems []map[string]any
	if current != nil && len(current.Items) > 0 {
		_ = json.Unmarshal(current.Items, &existingItems)
	}
	if existingItems == nil {
		existingItems = []map[string]any{}
	}
	names := make(map[string]bool)
	for _, it := range existingItems {
		if n, ok := it["name"].(string); ok {
			names[n] = true
		}
	}
	saved := 0
	for _, raw := range rawItems {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" || names[name] {
			continue
		}
		item := map[string]any{
			"name":    name,
			"type":    m["type"],
			"content": m["content"],
		}
		if f, ok := m["fields"].(map[string]any); ok {
			item["fields"] = f
		}
		existingItems = append(existingItems, item)
		names[name] = true
		saved++
	}
	if saved == 0 {
		return 0, nil
	}
	raw, _ := json.Marshal(existingItems)
	if _, err := s.docSvc.UpdateMemory(ctx, userID, novelID, raw, nil); err != nil {
		return 0, err
	}
	return saved, nil
}

// syncOutline merges LLM-provided acts into the novel's outline module
// (novel_outline). Every act the Agent produces is normalized to the web
// outline contract (id / nodes[] / node id+status) before it is stored, so a
// partially-shaped LLM payload can never reach the panel.
//
// Existing acts are preserved and repaired in place. A new act is folded into
// an existing act of the same title (nodes deduped by title) when one exists,
// and appended otherwise — keeping repeated save_outline calls idempotent.
func (s *AgentService) syncOutline(ctx context.Context, userID, novelID int64, rawActs []interface{}) (int, error) {
	current, err := s.docSvc.GetOutline(ctx, userID, novelID)
	if err != nil {
		return 0, err
	}
	var existingActs []map[string]any
	if current != nil && len(current.Acts) > 0 {
		_ = json.Unmarshal(current.Acts, &existingActs)
	}
	// Repair what is already stored: rows written before normalization may lack
	// ids/nodes, and merging requires a uniform shape. Nothing is dropped here.
	repaired := make([]map[string]any, 0, len(existingActs))
	for _, item := range existingActs {
		if act := repairOutlineAct(item); act != nil {
			repaired = append(repaired, act)
		}
	}
	existingActs = repaired

	saved := 0
	for _, raw := range rawActs {
		act := normalizeOutlineAct(raw)
		if act == nil {
			// Unusable act: not an object, or a blank title.
			continue
		}
		if !mergeOutlineAct(existingActs, act) {
			existingActs = append(existingActs, act)
		}
		saved++
	}
	if saved == 0 {
		return 0, nil
	}
	raw, err := json.Marshal(existingActs)
	if err != nil {
		return 0, err
	}
	// Guard (plan §七.3.1 "写前自动快照"): capture current outline before the
	// Agent merges/saves, so the pre-write outline is always recoverable.
	// Best-effort — failures are swallowed inside SnapshotOutline.
	s.docSvc.SnapshotOutline(ctx, userID, novelID)
	if _, err := s.docSvc.UpdateOutline(ctx, userID, novelID, raw, nil); err != nil {
		return 0, err
	}
	return saved, nil
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
