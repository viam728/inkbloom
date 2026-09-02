package service

import (
	"context"
	"encoding/json"
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
// assembly. AIVisible is a pointer so that "absent" (default visible) can
// be distinguished from an explicit false.
type agentMemoryItem struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Type            string          `json:"type"`
	Content         string          `json:"content"`
	Fields          json.RawMessage `json:"fields"`
	Pinned          bool            `json:"pinned"`
	AIVisible       *bool           `json:"ai_visible"`
	VisibleChapters []string        `json:"visible_chapters"`
	Relations       json.RawMessage `json:"relations"`
}

// ── Frozen output payload (field names must match the Python contract) ───

// AgentGeneratePayload is the request body forwarded to the Python
// /api/agents/generate endpoint.
type AgentGeneratePayload struct {
	Scene       string           `json:"scene"`
	Instruction string           `json:"instruction"`
	Context     AgentContextData `json:"context"`
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
type AgentOutlineNodeOut struct {
	Title   string `json:"title"`
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

// AgentChapterExcerpt is one preceding-chapter excerpt entry.
type AgentChapterExcerpt struct {
	Title   string `json:"title"`
	Excerpt string `json:"excerpt"`
}

// AgentMemoryItemOut is the memory-item shape forwarded to the AI service.
type AgentMemoryItemOut struct {
	Name      string          `json:"name"`
	Type      string          `json:"type"`
	Content   string          `json:"content"`
	Fields    json.RawMessage `json:"fields"`
	Relations json.RawMessage `json:"relations"`
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

// BuildAgentContext reads the novel's outline/memory documents and chapters
// within the user's scope, applies chapter-lock visibility filtering, and
// returns the payload frozen with the Python AI service. itemID/nodeID are
// optional pointers; an itemID that matches no memory item yields an empty
// target_item object.
func (s *AgentContextService) BuildAgentContext(
	ctx context.Context,
	userID, novelID int64,
	scene string,
	itemID, nodeID *string,
	instruction string,
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

	// Index node statuses for the chapter-lock rule and locate the chapter
	// linked to nodeID (preceding excerpts stop before it).
	doneNodes := make(map[string]bool)
	var cutoffChapterID int64
	for _, act := range acts {
		for _, node := range act.Nodes {
			if node.Status == "done" {
				doneNodes[node.ID] = true
			}
			if nodeID != nil && node.ID == *nodeID && node.ChapterID != nil {
				if id, convErr := strconv.ParseInt(*node.ChapterID, 10, 64); convErr == nil {
					cutoffChapterID = id
				}
			}
		}
	}

	payload := &AgentGeneratePayload{
		Scene:       scene,
		Instruction: instruction,
		Context: AgentContextData{
			NovelTitle:        novel.Title,
			NovelDescription:  desc,
			OutlineActs:       buildOutlineActsOut(acts),
			PrecedingChapters: buildPrecedingChapters(chapters, cutoffChapterID),
			MemoryItems:       buildMemoryItemsOut(filterVisibleItems(items, doneNodes)),
			TargetItem:        json.RawMessage("{}"),
			TargetNode:        json.RawMessage("{}"),
			KnowledgeNodes:    s.loadKnowledgeNodes(ctx, userID, novelID),
			ForeshadowThreads: s.loadForeshadowThreads(ctx, userID, novelID),
		},
	}

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

// filterVisibleItems applies the chapter-lock rules:
//   - items with an explicit ai_visible == false are dropped;
//   - items with a non-empty visible_chapters list are kept only when at
//     least one referenced outline node has status "done".
func filterVisibleItems(items []agentMemoryItem, doneNodes map[string]bool) []agentMemoryItem {
	visible := make([]agentMemoryItem, 0, len(items))
	for i := range items {
		item := &items[i]
		if item.AIVisible != nil && !*item.AIVisible {
			continue
		}
		if len(item.VisibleChapters) > 0 {
			unlocked := false
			for _, nodeID := range item.VisibleChapters {
				if doneNodes[nodeID] {
					unlocked = true
					break
				}
			}
			if !unlocked {
				continue
			}
		}
		visible = append(visible, *item)
	}
	return visible
}

// buildOutlineActsOut maps parsed acts to the frozen output shape.
func buildOutlineActsOut(acts []agentOutlineAct) []AgentOutlineActOut {
	out := make([]AgentOutlineActOut, 0, len(acts))
	for _, act := range acts {
		actOut := AgentOutlineActOut{
			Title: act.Title,
			Nodes: make([]AgentOutlineNodeOut, 0, len(act.Nodes)),
		}
		for _, node := range act.Nodes {
			actOut.Nodes = append(actOut.Nodes, AgentOutlineNodeOut{
				Title:   node.Title,
				Status:  node.Status,
				Summary: node.Summary,
			})
		}
		out = append(out, actOut)
	}
	return out
}

// buildPrecedingChapters walks chapters in position order (ListByNovelID
// already sorts ASC), stopping before the chapter linked to nodeID when a
// cutoff applies, and emits title+excerpt entries under a shared ~4000-rune
// budget.
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

// buildMemoryItemsOut maps visible items to the frozen output shape.
func buildMemoryItemsOut(items []agentMemoryItem) []AgentMemoryItemOut {
	out := make([]AgentMemoryItemOut, 0, len(items))
	for i := range items {
		out = append(out, toMemoryItemOut(&items[i]))
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
