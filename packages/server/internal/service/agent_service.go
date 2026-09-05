package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
	branchSvc    *BranchService
	agentContext *AgentContextService
	aiServiceURL string
	httpClient   *http.Client
	logger       *zap.Logger
}

// NewAgentService creates a new AgentService. branchSvc is optional (nil on
// test constructions): save_branch/list_branches degrade gracefully without it.
func NewAgentService(
	novelSvc *NovelService,
	chapterSvc *ChapterService,
	docSvc *NovelDocService,
	branchSvc *BranchService,
	agentContext *AgentContextService,
	aiServiceURL string,
	logger *zap.Logger,
) *AgentService {
	return &AgentService{
		novelSvc:     novelSvc,
		chapterSvc:   chapterSvc,
		docSvc:       docSvc,
		branchSvc:    branchSvc,
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
		ft("list_chapters", "列出某部小说的全部章节，按大纲顺序返回（order=大纲序号，从 1 开始；chapter_id=真实章节 ID）。章节顺序只认大纲顺序，不认标题。写章节前先用本工具确认正确的 chapter_id，避免误建章节。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
			},
			"required": []string{"novel_id"},
		}),
		ft("get_chapter_by_title", "按标题或关键词模糊查找章节，返回匹配的 chapter_id 与 title；找不到返回 found:false。仅用于用户给出（部分）标题名的场景；章节顺序/第N章一律以 list_chapters 的大纲序号为准。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"novel_id": map[string]any{"type": "integer", "description": "小说 ID"},
				"title":    map[string]any{"type": "string", "description": "章节标题或关键词"},
			},
			"required": []string{"novel_id", "title"},
		}),
	}
}

// systemPrompt is the Agent's persona + tool-usage rule. Identity truthfulness
// (answer "who are you" with the native model name, never a fake GPT persona)
// is injected centrally in ai-service's /api/agent/chat handler (_with_identity),
// so every conversational endpoint shares one source of truth and the resolved
// model name there is authoritative. Do NOT append an identity line here too.
const agentSystemPrompt = "你是 InkBloom 的创作 Agent，帮助用户创作小说。" +
	"你可以调用工具（create_novel / create_chapter / write_chapter / list_novels / list_chapters / get_chapter_by_title / save_memory / save_outline / save_branch / list_branches）" +
	"来实际创建作品、章节、撰写正文，并把角色/设定写入记忆模块、把情节规划写入大纲模块。" +
	"章节正文统一在大纲中管理：create_chapter 新建的章节会自动挂到大纲（同名要点绑定，否则末幕追加新要点），" +
	"因此规划整本书时优先 save_outline 生成幕/要点结构，再逐章 create_chapter + write_chapter，章节即可落到对应要点上。" +
	"执行工具后，用简洁中文向用户汇报结果。" +
	"当用户想开始创作时，主动调用工具完成任务，而不是只给建议。" +
	"章节顺序只认大纲顺序、不认标题（备忘录 L59）：大纲第 N 个要点即第 N 章，标题随时可改、不作为顺序依据。" +
	"当用户用'第N章'指代章节时，先调用 list_chapters，按返回的 order（大纲序号）定位 chapter_id，再 write_chapter；" +
	"只有当用户明确给出标题名时才用 get_chapter_by_title 模糊查找；不要凭空新建章节。"

// Run executes one Agent turn: given the conversation messages, it loops with
// the LLM (execute tool calls, feed results back) until the model returns a
// final answer. Returns the final answer text and the executed tool summary.
// novelID is the author's currently-selected work (0 when none): create/write
// tools fall back to it so the Agent never drafts without a target work.
// Run executes one full Agent loop: LLM decides tool calls, the Go service
// executes them for the real user and feeds results back until a final answer
// (or the step cap) is reached. model is the UI model selector's current
// value — empty means ai-service's default model; it is forwarded verbatim on
// every LLM call in the loop so mid-conversation switches take effect on the
// very next step.
func (s *AgentService) Run(ctx context.Context, userID int64, novelID int64, messages []map[string]any, model string) (string, []map[string]any, error) {
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
		resp, err := s.callLLM(ctx, msgs, model)
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

// callLLM performs one tool-calling LLM request. model is forwarded verbatim
// (empty = ai-service default) so the UI selector's choice reaches upstream.
func (s *AgentService) callLLM(ctx context.Context, messages []map[string]any, model string) (*llmResponse, error) {
	payload := map[string]any{
		"messages": messages,
		"tools":    s.toolSchema(),
	}
	if model != "" {
		payload["model"] = model
	}
	body, _ := json.Marshal(payload)
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

	case "save_branch":
		nid := resolveNovelID()
		title, _ := args["title"].(string)
		summary, _ := args["summary"].(string)
		if s.branchSvc == nil {
			return `{"error":"分支模块不可用"}`
		}
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		if title == "" || summary == "" {
			return `{"error":"title 与 summary 必填"}`
		}
		parentID, _ := args["parent_id"].(float64)
		chapterID, _ := args["chapter_id"].(float64)
		source, _ := args["source"].(string)
		b, err := s.branchSvc.Create(ctx, userID, &dto.CreateBranchRequest{
			NovelID:   nid,
			ParentID:  int64(parentID),
			Title:     title,
			Summary:   summary,
			Source:    source,
			ChapterID: int64(chapterID),
		})
		if err != nil {
			s.logger.Warn("agent save_branch failed", zap.Error(err))
			return `{"error":"保存分支失败"}`
		}
		return asJSON(map[string]any{"branch_id": b.ID, "title": b.Title})

	case "list_branches":
		nid := resolveNovelID()
		if s.branchSvc == nil {
			return `{"error":"分支模块不可用"}`
		}
		if nid <= 0 {
			return `{"error":"请先指定作品（novel_id）或选中一部作品"}`
		}
		list, err := s.branchSvc.List(ctx, userID, nid)
		if err != nil {
			s.logger.Warn("agent list_branches failed", zap.Error(err))
			return `{"error":"读取分支失败"}`
		}
		nodes := make([]map[string]any, 0, len(list))
		for _, b := range list {
			node := map[string]any{
				"id": b.ID, "parent_id": 0, "title": b.Title,
				"summary": b.Summary, "source": b.Source,
			}
			if b.ParentID != nil {
				node["parent_id"] = b.ParentID
			}
			if b.ChapterID != nil {
				node["chapter_id"] = b.ChapterID
			}
			nodes = append(nodes, node)
		}
		return asJSON(map[string]any{"branches": nodes})

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
		// 备忘录 L59：章节顺序 = 大纲顺序。按大纲 acts→nodes 数组序输出，
		// order 为大纲序号（第 N 个要点 = 第 N 章，未成稿要点无章节条目）；
		// 标题仅作展示，不作为顺序依据。未绑定大纲的存量章节垫在最后。
		items := make([]map[string]any, 0, len(list))
		if acts := s.loadAgentOutlineActs(ctx, userID, nid); len(acts) > 0 {
			byID := make(map[int64]dto.ChapterResponse, len(list))
			for _, c := range list {
				byID[c.ID] = c
			}
			order := 0
			seen := make(map[int64]bool, len(list))
			for _, act := range acts {
				for _, node := range act.Nodes {
					order++
					if node.ChapterID == nil {
						continue
					}
					id, perr := strconv.ParseInt(*node.ChapterID, 10, 64)
					if perr != nil {
						continue
					}
					c, ok := byID[id]
					if !ok || seen[id] {
						continue
					}
					seen[id] = true
					items = append(items, map[string]any{
						"order": order, "chapter_id": c.ID,
						"title": c.Title, "node_title": node.Title, "status": node.Status,
					})
				}
			}
			for _, c := range list {
				if seen[c.ID] {
					continue
				}
				order++
				items = append(items, map[string]any{"order": order, "chapter_id": c.ID, "title": c.Title})
			}
		} else {
			for i, c := range list {
				items = append(items, map[string]any{"order": i + 1, "chapter_id": c.ID, "title": c.Title})
			}
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

// loadAgentOutlineActs parses the novel's outline JSONB into the minimal
// act/node shape used for outline-ordered chapter listing (备忘录 L59).
// Absent or malformed documents yield nil so callers degrade to position order.
func (s *AgentService) loadAgentOutlineActs(ctx context.Context, userID, novelID int64) []agentOutlineAct {
	doc, err := s.docSvc.GetOutline(ctx, userID, novelID)
	if err != nil || doc == nil || len(doc.Acts) == 0 {
		return nil
	}
	var acts []agentOutlineAct
	if json.Unmarshal(doc.Acts, &acts) != nil {
		return nil
	}
	return acts
}

// outlineNodeIDForChapter returns the outline node id bound to chapterID,
// or nil when the chapter is unbound (or the outline is absent/malformed).
// This is the writing position for the memory access gates.
func (s *AgentService) outlineNodeIDForChapter(ctx context.Context, userID, novelID, chapterID int64) *string {
	cid := strconv.FormatInt(chapterID, 10)
	for _, act := range s.loadAgentOutlineActs(ctx, userID, novelID) {
		for _, node := range act.Nodes {
			if node.ChapterID != nil && *node.ChapterID == cid {
				id := node.ID
				return &id
			}
		}
	}
	return nil
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

	// 解析章节绑定的大纲节点（备忘录 L59：章节=大纲要点），作为写作位置
	// 传入上下文组装——记忆访问闸门（3 软闸 + 3 硬闸）按该位置求值；
	// 未绑定大纲的章节传 nil，位置型闸门按保守策略（fail-closed）处理。
	nodeID := s.outlineNodeIDForChapter(ctx, userID, novelID, chapterID)
	payload, err := s.agentContext.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nodeID, instruction, nil)
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
