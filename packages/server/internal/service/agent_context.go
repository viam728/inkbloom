package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
)

// precedingChapterBudget bounds the total rune count of preceding-chapter
// excerpts (titles included) embedded into the agent context.
const precedingChapterBudget = 4000

// descriptionContextBudget bounds the novel description (runes) embedded into
// the agent context, defensively truncating legacy over-long data.
const descriptionContextBudget = 800

// ── Minimal input parsing shapes (aligned with the frontend contract) ────

// agentOutlineNode is the minimal outline-node shape needed for context
// assembly. ChapterID is optional and links a node to a written chapter.
type agentOutlineNode struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Summary   string  `json:"summary"`
	Status    string  `json:"status"`
	ChapterID *string `json:"chapter_id"`
}

// agentOutlineAct is one act of the outline JSONB document.
type agentOutlineAct struct {
	ID    string             `json:"id"`
	Title string             `json:"title"`
	Nodes []agentOutlineNode `json:"nodes"`
}

// agentMemoryItem is the minimal memory-item shape needed for context
// assembly. AIVisible/VisibleChapters are the legacy chapter-lock fields
// (normalized into AIAccess on read); AIAccess is the six-gate permission
// (备忘录：3 软闸 + 3 硬闸).
type agentMemoryItem struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Type            string             `json:"type"`
	Content         string             `json:"content"`
	Fields          json.RawMessage    `json:"fields"`
	Pinned          bool               `json:"pinned"`
	AIVisible       *bool              `json:"ai_visible"`
	VisibleChapters []string           `json:"visible_chapters"`
	AIAccess        *agentMemoryAccess `json:"ai_access"`
	Relations       json.RawMessage    `json:"relations"`
}

// AI 访问闸门模式（备忘录：3 软闸 + 3 硬闸）。软闸注入条目并附带约束指令；
// 硬闸直接不注入（求值失败一律 fail-closed，宁可不带也不能剧透）。
const (
	accessIgnore             = "ignore"              // 软闸：注入但要求忽略，除非人类指令明确提及
	accessRestrictedVisible  = "restricted_visible"  // 软闸：解锁章及以后可见，此前仅可伏笔铺垫
	accessPartialVisible     = "partial_visible"     // 软闸：仅选中章可见，其余仅可伏笔铺垫
	accessDisabled           = "disabled"            // 硬闸：全局不注入
	accessRestrictedDisabled = "restricted_disabled" // 硬闸：解锁章及以后注入
	accessPartialDisabled    = "partial_disabled"    // 硬闸：仅选中章注入
)

// agentMemoryAccess is the per-item AI access gate config stored in the
// memory JSONB. unlock_chapter_id / visible_chapter_ids reference outline
// node ids (备忘录 L59：章节 = 大纲要点，顺序按大纲序).
type agentMemoryAccess struct {
	Mode              string   `json:"mode"`
	UnlockChapterID   string   `json:"unlock_chapter_id,omitempty"`
	VisibleChapterIDs []string `json:"visible_chapter_ids,omitempty"`
}

// effectiveAccess returns the item's access config, normalizing the legacy
// chapter-lock fields (ai_visible=false → disabled; visible_chapters →
// partial_visible) so old rows keep working without a data migration.
func (i *agentMemoryItem) effectiveAccess() *agentMemoryAccess {
	if i.AIAccess != nil && i.AIAccess.Mode != "" {
		return i.AIAccess
	}
	if i.AIVisible != nil && !*i.AIVisible {
		return &agentMemoryAccess{Mode: accessDisabled}
	}
	if len(i.VisibleChapters) > 0 {
		return &agentMemoryAccess{Mode: accessPartialVisible, VisibleChapterIDs: i.VisibleChapters}
	}
	return nil
}

// ── Frozen output payload (field names must match the Python contract) ───

// AgentGeneratePayload is the request body forwarded to the Python
// /api/agents/generate endpoint.
type AgentGeneratePayload struct {
	Scene       string           `json:"scene"`
	Instruction string           `json:"instruction"`
	Context     AgentContextData `json:"context"`
	// Model is the caller-selected model (empty → ai-service default).
	Model string `json:"model,omitempty"`
}

// AgentContextData carries the assembled novel context.
type AgentContextData struct {
	NovelTitle        string                `json:"novel_title"`
	NovelDescription  string                `json:"novel_description"`
	OutlineActs       []AgentOutlineActOut  `json:"outline_acts"`
	PrecedingChapters []AgentChapterExcerpt `json:"preceding_chapters"`
	MemoryItems       []AgentMemoryItemOut  `json:"memory_items"`
	TargetItem        json.RawMessage       `json:"target_item"`
	// TargetNode is the outline node to write (chapter scene).
	TargetNode json.RawMessage `json:"target_node"`
	// MemoryAccessRules carries the centralized 记忆访问规则 text (备忘录
	// 3 软闸) when any injected item carries an ignore/hidden directive.
	// Rendered by ai-service as a dedicated prompt block.
	MemoryAccessRules string                    `json:"memory_access_rules,omitempty"`
	// KnowledgeNodes carries the novel's established world-building nodes
	// (from the knowledge graph) so generation stays consistent with them.
	KnowledgeNodes []AgentKnowledgeNodeOut `json:"knowledge_nodes"`
	// ForeshadowThreads carries open (planted) threads so new chapters can
	// plant and pay off consistently.
	ForeshadowThreads []AgentForeshadowOut `json:"foreshadow_threads"`
}

// AgentKnowledgeNodeOut is one knowledge-graph node forwarded to the AI.
type AgentKnowledgeNodeOut struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description"`
}

// AgentForeshadowOut is one open foreshadow thread forwarded to the AI.
type AgentForeshadowOut struct {
	Description string `json:"description"`
	Status      string `json:"status"`
}

// AgentOutlineActOut is the act shape forwarded to the AI service.
type AgentOutlineActOut struct {
	Title string                `json:"title"`
	Nodes []AgentOutlineNodeOut `json:"nodes"`
}

// AgentOutlineNodeOut is the node shape forwarded to the AI service.
// ChapterID carries the bound chapter (0 = not yet written) so the model can
// address chapters by outline position instead of guessing by title.
type AgentOutlineNodeOut struct {
	Title     string `json:"title"`
	Status    string `json:"status"`
	Summary   string `json:"summary"`
	ChapterID int64  `json:"chapter_id,omitempty"`
}

// AgentChapterExcerpt is one preceding-chapter excerpt entry.
type AgentChapterExcerpt struct {
	Title   string `json:"title"`
	Excerpt string `json:"excerpt"`
}

// AgentMemoryItemOut is the memory-item shape forwarded to the AI service.
type AgentMemoryItemOut struct {
	Name      string               `json:"name"`
	Type      string               `json:"type"`
	Content   string               `json:"content"`
	Fields    json.RawMessage      `json:"fields"`
	Relations json.RawMessage      `json:"relations"`
	// Access carries the resolved per-item visibility directive for soft
	// gates (ignore / hidden). nil = 无限制；硬闸条目根本不会进入本列表。
	Access *AgentMemoryAccessOut `json:"access,omitempty"`
}

// AgentMemoryAccessOut is the soft-gate directive rendered into the prompt.
type AgentMemoryAccessOut struct {
	// Visibility is one of "ignore" | "hidden".
	Visibility string `json:"visibility"`
	// Note is the Go-rendered Chinese directive so ai-service only prints it.
	Note string `json:"note,omitempty"`
}

// AgentContextService assembles the frozen agent-generation context from the
// outline / memory JSONB documents and the chapter list.
type AgentContextService struct {
	novelRepo      repository.NovelRepository
	docRepo        repository.NovelDocRepository
	chapterRepo    repository.ChapterRepository
	knowledgeRepo  repository.KnowledgeRepository
	foreshadowRepo repository.ForeshadowRepository
}

// NewAgentContextService creates a new AgentContextService.
func NewAgentContextService(
	nr repository.NovelRepository,
	dr repository.NovelDocRepository,
	cr repository.ChapterRepository,
) *AgentContextService {
	return &AgentContextService{novelRepo: nr, docRepo: dr, chapterRepo: cr}
}

// WithKnowledgeAndForeshadow wires the optional knowledge-graph and
// foreshadow repositories so the assembled context can carry the novel's
// established world-building nodes and open threads (closed-loop Agent,
// plan P2-b). Without them the context simply omits those sections.
func (s *AgentContextService) WithKnowledgeAndForeshadow(kr repository.KnowledgeRepository, fr repository.ForeshadowRepository) *AgentContextService {
	s.knowledgeRepo = kr
	s.foreshadowRepo = fr
	return s
}

// AgentContextOptions toggles which context blocks are assembled into the
// payload (AIGC 卡可选上下文注入). Pointer fields: nil = include (default),
// false = omit the block. TargetItem（记忆 AIGC 卡的显式任务对象）不受
// IncludeMemory 约束——显式点名等同「人类指令明确提及」。
type AgentContextOptions struct {
	IncludeOutline    *bool
	IncludeMemory     *bool
	IncludeForeshadow *bool
	IncludePreceding  *bool
}

// enabled resolves an optional flag: nil → true.
func enabled(f *bool) bool {
	return f == nil || *f
}

// BuildAgentContext reads the novel's outline/memory documents and chapters
// within the user's scope, applies chapter-lock visibility filtering, and
// returns the payload frozen with the Python AI service. itemID/nodeID are
// optional pointers; an itemID that matches no memory item yields an empty
// target_item object. opts toggles optional context blocks (nil = 全量).
func (s *AgentContextService) BuildAgentContext(
	ctx context.Context,
	userID, novelID int64,
	scene string,
	itemID, nodeID *string,
	instruction string,
	opts *AgentContextOptions,
) (*AgentGeneratePayload, error) {
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	if novel == nil {
		return nil, ErrNotFound
	}

	desc := ""
	if novel.Description != nil {
		desc = truncateRunes(*novel.Description, descriptionContextBudget)
	}

	acts := s.loadOutlineActs(ctx, userID, novelID)
	items := s.loadMemoryItems(ctx, userID, novelID)

	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	// 备忘录 L57/59：章节顺序 = 大纲顺序。前文摘录按大纲序推进，
	// Agent 对"上一章/前文章节"的感知与作者侧章节序列一致。
	chapters = orderedChaptersByOutline(chapters, acts)

	// Linearize the outline (acts→nodes order, 与 Python 端「第N章」编号一致)
	// into nodeID→position/title maps, and locate the chapter linked to nodeID
	// (preceding excerpts stop before it; memory gates evaluate at its position).
	nodePos := make(map[string]int)
	nodeTitle := make(map[string]string)
	var cutoffChapterID int64
	targetNodeID := ""
	if nodeID != nil {
		targetNodeID = *nodeID
	}
	seq := 0
	for _, act := range acts {
		for _, node := range act.Nodes {
			seq++
			nodePos[node.ID] = seq
			nodeTitle[node.ID] = node.Title
			if nodeID != nil && node.ID == *nodeID && node.ChapterID != nil {
				if id, convErr := strconv.ParseInt(*node.ChapterID, 10, 64); convErr == nil {
					cutoffChapterID = id
				}
			}
		}
	}

	resolved := resolveMemoryItems(items, targetNodeID, nodePos, nodeTitle)

	// AIGC 卡可选上下文注入：按调用方开关裁剪装配块（nil = 照常注入）。
	var outlineOut []AgentOutlineActOut
	var precedingOut []AgentChapterExcerpt
	var memoryOut []AgentMemoryItemOut
	memoryRules := ""
	var foreshadowOut []AgentForeshadowOut
	if opts == nil || enabled(opts.IncludeOutline) {
		outlineOut = buildOutlineActsOut(acts)
	}
	if opts == nil || enabled(opts.IncludePreceding) {
		precedingOut = buildPrecedingChapters(chapters, cutoffChapterID)
	}
	if opts == nil || enabled(opts.IncludeMemory) {
		memoryOut = buildMemoryItemsOut(resolved)
		memoryRules = memoryAccessRules(resolved)
	}
	if opts == nil || enabled(opts.IncludeForeshadow) {
		foreshadowOut = s.loadForeshadowThreads(ctx, userID, novelID)
	}

	payload := &AgentGeneratePayload{
		Scene:       scene,
		Instruction: instruction,
		Context: AgentContextData{
			NovelTitle:        novel.Title,
			NovelDescription:  desc,
			OutlineActs:       outlineOut,
			PrecedingChapters: precedingOut,
			MemoryItems:       memoryOut,
			MemoryAccessRules: memoryRules,
			TargetItem:        json.RawMessage("{}"),
			TargetNode:        json.RawMessage("{}"),
			KnowledgeNodes:    s.loadKnowledgeNodes(ctx, userID, novelID),
			ForeshadowThreads: foreshadowOut,
		},
	}

	// target_item：调用方显式指定要生成/编辑的条目（记忆 AIGC 卡）。
	// 这是作者对该条目的直接点名，等同「人类指令明确提及」——即使条目
	// 带闸门也照常注入（闸门只约束记忆列表的被动注入，不拦显式任务对象）。
	if itemID != nil {
		for i := range items {
			if items[i].ID == *itemID {
				target, marshalErr := json.Marshal(toMemoryItemOut(&items[i]))
				if marshalErr == nil {
					payload.Context.TargetItem = target
				}
				break
			}
		}
	}

	// Fill the target node (chapter scene) for the node referenced by nodeID.
	if nodeID != nil {
		for _, act := range acts {
			for _, node := range act.Nodes {
				if node.ID == *nodeID {
					target, marshalErr := json.Marshal(map[string]interface{}{
						"title":   node.Title,
						"summary": node.Summary,
						"status":  node.Status,
					})
					if marshalErr == nil {
						payload.Context.TargetNode = target
					}
					break
				}
			}
		}
	}

	return payload, nil
}

// loadOutlineActs parses the outline JSONB; malformed or absent documents
// degrade to an empty act list instead of failing the whole request.
func (s *AgentContextService) loadOutlineActs(ctx context.Context, userID, novelID int64) []agentOutlineAct {
	doc, err := s.docRepo.GetOutline(ctx, userID, novelID)
	if err != nil || len(doc.Acts) == 0 {
		return nil
	}
	var acts []agentOutlineAct
	if err := json.Unmarshal(doc.Acts, &acts); err != nil {
		return nil
	}
	return acts
}

// loadMemoryItems parses the memory JSONB with the same lenient semantics.
func (s *AgentContextService) loadMemoryItems(ctx context.Context, userID, novelID int64) []agentMemoryItem {
	doc, err := s.docRepo.GetMemory(ctx, userID, novelID)
	if err != nil || len(doc.Items) == 0 {
		return nil
	}
	var items []agentMemoryItem
	if err := json.Unmarshal(doc.Items, &items); err != nil {
		return nil
	}
	return items
}

// resolvedMemoryItem is one memory item that survived the hard gates together
// with its soft-gate directive (visibility visible 时无约束，不出现在 payload)。
type resolvedMemoryItem struct {
	item       agentMemoryItem
	visibility string // "visible" | "ignore" | "hidden"
	note       string
}

// resolveMemoryItems evaluates every item's access gate at the current
// writing position (备忘录：3 软闸 + 3 硬闸) and returns the items to inject
// with their soft-gate directives:
//
//   - 硬闸（disabled / restricted_disabled / partial_disabled）：位置不允许的
//     条目在此被丢弃，绝不进入 payload —— 这是唯一的绝对保证；
//   - 软闸（ignore / restricted_visible / partial_visible）：条目照常注入，
//     但附带 ignore/hidden 标注与约束指令（允许伏笔铺垫）；
//   - 无 targetNodeID（大纲生成/纯聊天等无写作位置的场景）：位置型闸门一律
//     fail-closed —— 硬闸不注入、软闸按 hidden 处理，宁可保守不可剧透。
//
// pos maps outline node id → 1-based 大纲序（acts→nodes 展开序），title maps
// node id → 章名（渲染限制说明用）。缺参（未选解锁章/可见章集合为空）同样
// fail-closed：软闸视为 hidden、硬闸不注入。
func resolveMemoryItems(items []agentMemoryItem, targetNodeID string, pos map[string]int, title map[string]string) []resolvedMemoryItem {
	out := make([]resolvedMemoryItem, 0, len(items))
	targetPos := 0
	if p, ok := pos[targetNodeID]; ok {
		targetPos = p
	}
	hasTarget := targetNodeID != "" && targetPos > 0
	for i := range items {
		item := &items[i]
		acc := item.effectiveAccess()
		if acc == nil {
			out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})
			continue
		}
		switch acc.Mode {
		case accessDisabled:
			// 硬闸：全局不注入。
			continue

		case accessRestrictedDisabled:
			unlock, ok := pos[acc.UnlockChapterID]
			if !hasTarget || !ok || targetPos < unlock {
				continue
			}
			out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})

		case accessPartialDisabled:
			if !hasTarget || !containsID(acc.VisibleChapterIDs, targetNodeID) {
				continue
			}
			out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})

		case accessIgnore:
			out = append(out, resolvedMemoryItem{
				item:       *item,
				visibility: "ignore",
				note:       "除非用户当前指令明确提及本条目，否则忽略其内容：不得在正文中使用、复述或据其展开情节。",
			})

		case accessRestrictedVisible:
			unlock, ok := pos[acc.UnlockChapterID]
			if hasTarget && ok && targetPos >= unlock {
				out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})
				continue
			}
			note := "本条目对当前章节属于未来剧情信息：绝对不能剧透、提前显露或直接揭示，仅允许以伏笔、暗示、隐晦线索的方式铺垫。"
			if t, ok := title[acc.UnlockChapterID]; ok && t != "" {
				note = fmt.Sprintf("本条目自「%s」章起解锁；在该章之前" + note, t)
			}
			out = append(out, resolvedMemoryItem{item: *item, visibility: "hidden", note: note})

		case accessPartialVisible:
			if hasTarget && containsID(acc.VisibleChapterIDs, targetNodeID) {
				out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})
				continue
			}
			out = append(out, resolvedMemoryItem{
				item:       *item,
				visibility: "hidden",
				note:       "本条目仅在指定章节可见，当前章节不可见：绝对不能剧透、提前显露或直接揭示，仅允许以伏笔、暗示、隐晦线索的方式铺垫。",
			})

		default:
			// 未知模式（契约演进容错）：按无限制处理。
			out = append(out, resolvedMemoryItem{item: *item, visibility: "visible"})
		}
	}
	return out
}

// containsID reports whether ids contains id.
func containsID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// memoryAccessRules returns the centralized 记忆访问规则 text (rendered by
// ai-service as a dedicated block) when any injected item carries a soft-gate
// directive, and "" otherwise to keep the payload lean.
func memoryAccessRules(resolved []resolvedMemoryItem) string {
	hasIgnore, hasHidden := false, false
	for _, r := range resolved {
		switch r.visibility {
		case "ignore":
			hasIgnore = true
		case "hidden":
			hasHidden = true
		}
	}
	if !hasIgnore && !hasHidden {
		return ""
	}
	rules := "下列记忆条目带有访问限制标注，必须严格遵守："
	if hasIgnore {
		rules += "标注「忽略」的条目，除非用户当前指令明确提及，否则不得使用其内容；"
	}
	if hasHidden {
		rules += "标注「隐藏」的条目对当前章节属于未来剧情信息，绝对不能剧透、提前显露或直接揭示，只允许以伏笔、暗示、隐晦线索的方式铺垫。"
	}
	return rules
}

// buildOutlineActsOut maps parsed acts to the frozen output shape. Each node
// carries its bound chapter_id (0 = 未成稿) and the outline order doubles as
// the chapter sequence (备忘录 L59: Agent 按大纲顺序 id 认章节，不认标题).
func buildOutlineActsOut(acts []agentOutlineAct) []AgentOutlineActOut {
	out := make([]AgentOutlineActOut, 0, len(acts))
	for _, act := range acts {
		actOut := AgentOutlineActOut{
			Title: act.Title,
			Nodes: make([]AgentOutlineNodeOut, 0, len(act.Nodes)),
		}
		for _, node := range act.Nodes {
			nodeOut := AgentOutlineNodeOut{
				Title:   node.Title,
				Status:  node.Status,
				Summary: node.Summary,
			}
			if node.ChapterID != nil {
				if id, err := strconv.ParseInt(*node.ChapterID, 10, 64); err == nil {
					nodeOut.ChapterID = id
				}
			}
			actOut.Nodes = append(actOut.Nodes, nodeOut)
		}
		out = append(out, actOut)
	}
	return out
}

// orderedChaptersByOutline returns the chapters in outline order (备忘录 L57/59):
// chapters bound to outline nodes come first following the acts→nodes array
// order; unbound legacy chapters keep their position order afterwards. This is
// the canonical chapter sequence the agent must reason about — titles are
// cosmetic and may change freely.
func orderedChaptersByOutline(chapters []model.Chapter, acts []agentOutlineAct) []model.Chapter {
	byID := make(map[int64]model.Chapter, len(chapters))
	for _, c := range chapters {
		byID[c.ID] = c
	}
	out := make([]model.Chapter, 0, len(chapters))
	seen := make(map[int64]bool, len(chapters))
	for _, act := range acts {
		for _, node := range act.Nodes {
			if node.ChapterID == nil {
				continue
			}
			if id, err := strconv.ParseInt(*node.ChapterID, 10, 64); err == nil {
				if c, ok := byID[id]; ok && !seen[id] {
					out = append(out, c)
					seen[id] = true
				}
			}
		}
	}
	for _, c := range chapters {
		if !seen[c.ID] {
			out = append(out, c)
		}
	}
	return out
}

// buildPrecedingChapters walks chapters in the canonical outline order
// (chapters bound to outline nodes first, in acts→nodes array order; unbound
// legacy chapters keep position order afterwards), stopping before the chapter
// linked to nodeID when a cutoff applies, and emits title+excerpt entries
// under a shared ~4000-rune budget.
func buildPrecedingChapters(chapters []model.Chapter, cutoffChapterID int64) []AgentChapterExcerpt {
	out := make([]AgentChapterExcerpt, 0, len(chapters))
	budget := precedingChapterBudget
	for i := range chapters {
		if cutoffChapterID > 0 && chapters[i].ID == cutoffChapterID {
			break
		}
		if budget <= 0 {
			break
		}
		title := truncateRunes(chapters[i].Title, budget)
		remaining := budget - len([]rune(title))
		var excerpt string
		if chapters[i].Content != nil {
			excerpt = truncateRunes(*chapters[i].Content, remaining)
		}
		budget -= len([]rune(excerpt))
		out = append(out, AgentChapterExcerpt{Title: title, Excerpt: excerpt})
	}
	return out
}

// buildMemoryItemsOut maps resolved items to the frozen output shape,
// attaching the soft-gate access directive (visible 且无约束的条目不带 access).
func buildMemoryItemsOut(resolved []resolvedMemoryItem) []AgentMemoryItemOut {
	out := make([]AgentMemoryItemOut, 0, len(resolved))
	for i := range resolved {
		r := &resolved[i]
		itemOut := toMemoryItemOut(&r.item)
		if r.visibility == "ignore" || r.visibility == "hidden" {
			itemOut.Access = &AgentMemoryAccessOut{Visibility: r.visibility, Note: r.note}
		}
		out = append(out, itemOut)
	}
	return out
}

// toMemoryItemOut normalizes optional raw fields so the payload always
// carries a fields object and a relations array.
func toMemoryItemOut(item *agentMemoryItem) AgentMemoryItemOut {
	fields := item.Fields
	if len(fields) == 0 {
		fields = json.RawMessage("{}")
	}
	relations := item.Relations
	if len(relations) == 0 {
		relations = json.RawMessage("[]")
	}
	return AgentMemoryItemOut{
		Name:      item.Name,
		Type:      item.Type,
		Content:   item.Content,
		Fields:    fields,
		Relations: relations,
	}
}

// truncateRunes trims s to at most n runes.
func truncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// loadKnowledgeNodes reads the novel's knowledge-graph nodes (capped) for
// closed-loop generation. Absence of the repo (or no nodes) yields an empty
// slice so downstream formatting simply skips the section.
func (s *AgentContextService) loadKnowledgeNodes(ctx context.Context, userID, novelID int64) []AgentKnowledgeNodeOut {
	if s.knowledgeRepo == nil {
		return []AgentKnowledgeNodeOut{}
	}
	nodes, err := s.knowledgeRepo.GetNodesByNovel(ctx, userID, novelID)
	if err != nil || len(nodes) == 0 {
		return []AgentKnowledgeNodeOut{}
	}
	const cap = 50
	if len(nodes) > cap {
		nodes = nodes[:cap]
	}
	out := make([]AgentKnowledgeNodeOut, 0, len(nodes))
	for i := range nodes {
		n := &nodes[i]
		typ := ""
		if n.Type != nil {
			typ = *n.Type
		}
		desc := ""
		if n.Properties != nil {
			var props map[string]interface{}
			if json.Unmarshal(n.Properties, &props) == nil {
				if d, ok := props["description"].(string); ok {
					desc = d
				}
			}
		}
		out = append(out, AgentKnowledgeNodeOut{Name: n.Name, Type: typ, Description: desc})
	}
	return out
}

// loadForeshadowThreads reads open (planted) foreshadow threads so new
// chapters can plant/pay off consistently. Absence yields an empty slice.
func (s *AgentContextService) loadForeshadowThreads(ctx context.Context, userID, novelID int64) []AgentForeshadowOut {
	if s.foreshadowRepo == nil {
		return []AgentForeshadowOut{}
	}
	threads, err := s.foreshadowRepo.ListByStatus(ctx, userID, novelID, []string{model.ForeshadowPlanted})
	if err != nil || len(threads) == 0 {
		return []AgentForeshadowOut{}
	}
	const cap = 30
	if len(threads) > cap {
		threads = threads[:cap]
	}
	out := make([]AgentForeshadowOut, 0, len(threads))
	for i := range threads {
		out = append(out, AgentForeshadowOut{Description: threads[i].Description, Status: threads[i].Status})
	}
	return out
}
