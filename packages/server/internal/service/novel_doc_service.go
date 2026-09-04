package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/idgen"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/datatypes"
)

// ErrPayloadTooLarge is returned when a document payload exceeds the 2MB limit.
var ErrPayloadTooLarge = errors.New("payload exceeds the 2MB limit")

// ErrVersionConflict is returned when the client-supplied version does not
// match the version currently stored.
var ErrVersionConflict = errors.New("version conflict")

// maxDocPayloadBytes caps outline/memory request payloads at 2MB.
const maxDocPayloadBytes = 2 << 20

// OutlineDoc is the wire shape of GET/PUT /novels/:id/outline responses.
// Acts is passed through verbatim; no Go-side OutlineAct struct to avoid
// schema drift with the frontend.
type OutlineDoc struct {
	Acts    json.RawMessage `json:"acts"`
	Version int             `json:"version"`
}

// MemoryDoc is the wire shape of GET/PUT /novels/:id/memory responses.
type MemoryDoc struct {
	Items   json.RawMessage `json:"items"`
	Version int             `json:"version"`
}

// RhythmPoint is one point of the rhythm curve: tension score per chapter.
type RhythmPoint struct {
	ChapterID int64 `json:"chapter_id"`
	Score     int   `json:"score"`
}

// NovelDocService handles outline / memory / rhythm business logic.
type NovelDocService struct {
	novelRepo         repository.NovelRepository
	docRepo           repository.NovelDocRepository
	chapterRepo       repository.ChapterRepository
	outlineVersionRepo repository.OutlineVersionRepository
}

// WithDocRepo returns a shallow copy of the service whose document writes go
// through the given repo (a transaction-bound instance during the atomic
// restore, F1-7). The copy shares the other dependencies by design.
func (s *NovelDocService) WithDocRepo(dr repository.NovelDocRepository) *NovelDocService {
	if s == nil {
		return nil
	}
	clone := *s
	clone.docRepo = dr
	return &clone
}

// NewNovelDocService creates a new NovelDocService.
func NewNovelDocService(
	nr repository.NovelRepository,
	dr repository.NovelDocRepository,
	cr repository.ChapterRepository,
	ovr repository.OutlineVersionRepository,
) *NovelDocService {
	return &NovelDocService{novelRepo: nr, docRepo: dr, chapterRepo: cr, outlineVersionRepo: ovr}
}

// SnapshotOutline captures the novel's current outline (acts) before an Agent
// mutation is applied, so an Agent write over the outline is always recoverable
// through the version-history infra (plan §七.3.1 "写前自动快照"). The snapshot
// is written to the outline_versions table and then pruned to a per-novel cap.
//
// Best-effort by design: every error is logged and swallowed, and the method
// never returns an error that could block or fail the calling write. A missing
// or empty outline is a no-op.
func (s *NovelDocService) SnapshotOutline(ctx context.Context, userID, novelID int64) {
	if s.outlineVersionRepo == nil {
		return
	}
	current, err := s.GetOutline(ctx, userID, novelID)
	if err != nil {
		zap.L().Warn("agent outline snapshot: get outline failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return
	}
	if current == nil || len(current.Acts) == 0 {
		return
	}
	v := &model.OutlineVersion{
		UserID: userID,
		NovelID: novelID,
		Acts:    datatypes.JSON(current.Acts),
		Kind:    model.VersionKindAgentAuto,
		Label:   "agent-auto",
	}
	if err := s.outlineVersionRepo.Create(ctx, v); err != nil {
		zap.L().Warn("agent outline snapshot: create failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return
	}
	if _, err := s.outlineVersionRepo.PruneAuto(ctx, userID, novelID, 50); err != nil {
		zap.L().Warn("agent outline snapshot: prune failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
	}
}

// GetOutline returns the outline document of a novel within the user's
// scope (empty acts when absent).
//
// Acts are normalized on the way out: legacy rows written before outline
// normalization existed (or by an unpatched Agent build) may lack act ids,
// node ids or node statuses, which crashed the web panel. Repairing at the read
// boundary heals them without a migration, and the client's next PUT persists
// the repaired shape.
func (s *NovelDocService) GetOutline(ctx context.Context, userID, novelID int64) (*OutlineDoc, error) {
	if err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return nil, err
	}
	doc, err := s.docRepo.GetOutline(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	return &OutlineDoc{Acts: normalizeOutlineActsJSON(json.RawMessage(doc.Acts)), Version: doc.Version}, nil
}

// UpdateOutline wholesale-replaces the outline acts of a novel and returns
// the new version. expectedVersion is an optional soft concurrency check:
// when supplied and stale, ErrVersionConflict is returned.
func (s *NovelDocService) UpdateOutline(ctx context.Context, userID, novelID int64, acts json.RawMessage, expectedVersion *int) (int, error) {
	if err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return 0, err
	}
	if err := validateDocPayload(acts); err != nil {
		return 0, err
	}
	// R1 dedup (reddots §十): fold near-duplicate act titles for EVERY writer
	// of the outline — the web panel's PUT as well as the Agent's
	// save_outline, which previously was the only deduplicated path.
	acts = dedupOutlineActs(acts)
	if expectedVersion != nil {
		current, err := s.docRepo.GetOutline(ctx, userID, novelID)
		if err != nil {
			return 0, err
		}
		if *expectedVersion != current.Version {
			return 0, ErrVersionConflict
		}
	}

	doc := &model.NovelOutline{UserID: userID, NovelID: novelID, Acts: datatypes.JSON(acts)}
	if err := s.docRepo.UpsertOutline(ctx, doc); err != nil {
		zap.L().Error("failed to upsert novel outline", zap.Int64("novel_id", novelID), zap.Error(err))
		return 0, err
	}
	return doc.Version, nil
}

// GetMemory returns the memory document of a novel within the user's scope
// (empty items when absent).
func (s *NovelDocService) GetMemory(ctx context.Context, userID, novelID int64) (*MemoryDoc, error) {
	if err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return nil, err
	}
	doc, err := s.docRepo.GetMemory(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	return &MemoryDoc{Items: json.RawMessage(doc.Items), Version: doc.Version}, nil
}

// UpdateMemory wholesale-replaces the memory items of a novel and returns
// the new version, with the same soft version-check semantics as UpdateOutline.
func (s *NovelDocService) UpdateMemory(ctx context.Context, userID, novelID int64, items json.RawMessage, expectedVersion *int) (int, error) {
	if err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return 0, err
	}
	if err := validateDocPayload(items); err != nil {
		return 0, err
	}
	if expectedVersion != nil {
		current, err := s.docRepo.GetMemory(ctx, userID, novelID)
		if err != nil {
			return 0, err
		}
		if *expectedVersion != current.Version {
			return 0, ErrVersionConflict
		}
	}

	doc := &model.NovelMemory{UserID: userID, NovelID: novelID, Items: datatypes.JSON(items)}
	if err := s.docRepo.UpsertMemory(ctx, doc); err != nil {
		zap.L().Error("failed to upsert novel memory", zap.Int64("novel_id", novelID), zap.Error(err))
		return 0, err
	}
	return doc.Version, nil
}

// GetRhythm computes a heuristic tension curve (0-100) over the novel's
// non-soft-deleted chapters ordered by position. Server-side it uses
// word-count deviation from the mean plus title-keyword weighting, mirroring
// the frontend fallback heuristic; no LLM call, no caching.
func (s *NovelDocService) GetRhythm(ctx context.Context, userID, novelID int64) ([]RhythmPoint, error) {
	if err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return nil, err
	}
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	return computeRhythmPoints(chapters), nil
}

// ensureNovelExists maps a missing or foreign-owned novel to ErrNotFound
// (404 semantics; existence of other users' novels is never revealed).
func (s *NovelDocService) ensureNovelExists(ctx context.Context, userID, novelID int64) error {
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		return err
	}
	if novel == nil {
		return ErrNotFound
	}
	return nil
}

// validateDocPayload enforces the 2MB size cap and a valid top-level JSON array.
func validateDocPayload(data json.RawMessage) error {
	if len(data) > maxDocPayloadBytes {
		return ErrPayloadTooLarge
	}
	if len(data) == 0 || !json.Valid(data) {
		return ErrInvalidInput
	}
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return ErrInvalidInput
	}
	return nil
}

// tensionKeywords boost a chapter's score when present in its title —
// markers of conflict / revelation commonly carrying high tension.
var tensionKeywords = []string{
	"死", "杀", "血", "逃", "追", "爆", "战", "决", "背叛", "逆转", "崩塌",
	"真相", "危机", "绝望", "袭击", "决裂", "告白", "别离", "火", "刃",
	"囚", "毒", "影", "谜", "终局", "对峙",
}

// computeRhythmPoints scores chapters by word-count deviation from the mean
// (baseline component) plus title keyword weighting (boost component).
func computeRhythmPoints(chapters []model.Chapter) []RhythmPoint {
	points := make([]RhythmPoint, 0, len(chapters))
	if len(chapters) == 0 {
		return points
	}

	total := 0
	for i := range chapters {
		total += chapters[i].WordCount
	}
	mean := float64(total) / float64(len(chapters))

	for i := range chapters {
		c := &chapters[i]
		var score float64
		if c.WordCount <= 0 {
			// Empty chapter: low-energy baseline to keep the curve continuous.
			score = 25
		} else if mean > 0 {
			dev := (float64(c.WordCount) - mean) / mean
			if dev < -1 {
				dev = -1
			}
			if dev > 1 {
				dev = 1
			}
			score = 50 + dev*30
		} else {
			score = 50
		}

		boost := 0
		for _, kw := range tensionKeywords {
			if strings.Contains(c.Title, kw) {
				boost += 6
			}
		}
		if boost > 20 {
			boost = 20
		}
		score += float64(boost)

		points = append(points, RhythmPoint{
			ChapterID: c.ID,
			Score:     int(math.Round(clampF(score, 5, 100))),
		})
	}
	return points
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ── 章节 ↔ 大纲统一绑定（文章库并入大纲：章节正文统一在大纲管理） ──────────
//
// With the standalone article library removed, a chapter that no outline node
// references is unreachable content. Every writer of chapters therefore binds
// them into the outline:
//   - AI 起稿采纳 (StoryService.AdoptChapter) and the Agent's create_chapter
//     call BindChapterToOutline at creation time;
//   - legacy orphans (old article-library chapters never bound to the outline)
//     are DELETED by the idempotent startup migration
//     MigrateCleanupOrphanChapters (wired in cmd/server/main.go) so novel word
//     counts no longer include deprecated article-library data.
//
// Binding is title-keyed (chapterTitleKey, ordinal-insensitive) so a drafted
// "第3章 觉醒" binds to the planned node "觉醒"; when no unbound node matches,
// a new node is appended to the last act (creating a first act when the
// outline is empty).

// BindChapterToOutline binds one chapter into the novel's outline. Best-effort
// by design: errors are logged and swallowed so AI adoption / agent chapter
// creation never fail because of the outline binding. drafting marks a chapter
// that already carries content (node status bumps planned → drafting).
func (s *NovelDocService) BindChapterToOutline(ctx context.Context, userID, novelID, chapterID int64, title string, drafting bool) {
	// Tests may construct callers (Agent/Story services) without a doc service.
	if s == nil || s.docRepo == nil {
		return
	}
	ch := model.Chapter{ID: chapterID, UserID: userID, NovelID: novelID, Title: title}
	if drafting {
		ch.WordCount = 1
	}
	if _, _, err := s.bindChaptersToOutline(ctx, userID, novelID, []model.Chapter{ch}); err != nil {
		zap.L().Warn("bind chapter to outline failed",
			zap.Int64("novel_id", novelID), zap.Int64("chapter_id", chapterID), zap.Error(err))
	}
}

// MigrateCleanupOrphanChapters repairs chapter↔outline binding and deletes
// deprecated article-library chapters (article library merged into outline
// management). Per novel:
//
//  1. Phantom repair — nodes whose chapter_id points at a chapter that does
//     not exist (legacy local-mode data synced to the server: the browser
//     generated Date.now() ids that never became rows) are unbound. Without
//     this the UI's 写正文 keeps spawning duplicate empty shells for those
//     nodes (observed in the wild).
//  2. Title rebind — real chapters not referenced by any node are bound to
//     the first unbound node with a matching title (chapterTitleKey,
//     ordinal-insensitive). Chapters carrying content are matched first so a
//     real chapter wins over an empty duplicate shell. This preserves the
//     outline manager's binding data instead of discarding written work.
//  3. Cleanup — chapters still unreferenced (old article-library chapters
//     with no matching outline node) are deleted, and the novel's aggregated
//     word_count is recomputed so deprecated data stops being counted.
//
// Unlike BindChapterToOutline this migration never APPENDS new nodes: an
// unbound legacy chapter is deprecated, not promoted. Idempotent, intended
// for server startup; returns the number of chapters deleted. Best-effort:
// per-novel failures are logged and skipped; a corrupt outline document skips
// the novel entirely rather than risk mass-deleting chapters.
// MigrateCleanupOrphanChapters deletes chapters no longer bound to any
// outline node (deprecated article-library data). Chapters are soft-deleted
// and deletions are logged with full ids. Returns the deletion count; the
// error surfaces store-level failures so startup can refuse to continue
// rather than silently skipping the migration (F1-7).
func (s *NovelDocService) MigrateCleanupOrphanChapters(ctx context.Context) (int, error) {
	if s == nil || s.novelRepo == nil || s.chapterRepo == nil {
		return 0, nil
	}
	novels, err := s.novelRepo.ListAll(ctx)
	if err != nil {
		return 0, fmt.Errorf("orphan-chapter cleanup: list novels: %w", err)
	}
	deleted := 0
	for _, n := range novels {
		chapters, err := s.chapterRepo.ListByNovelID(ctx, n.UserID, n.ID)
		if err != nil || len(chapters) == 0 {
			continue
		}
		doc, err := s.docRepo.GetOutline(ctx, n.UserID, n.ID)
		if err != nil {
			continue
		}
		acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(doc.Acts)))
		if !ok {
			// Unparseable outline: never guess — keep the chapters.
			zap.L().Warn("orphan-chapter cleanup: unparseable outline, skipping novel",
				zap.Int64("novel_id", n.ID))
			continue
		}

		// 1) Phantom repair: drop chapter_id bindings that reference
		// non-existent chapters, and clear duplicate bindings (one chapter per
		// node). boundOrder is the outline-ordered list of still-valid ids.
		existing := make(map[int64]bool, len(chapters))
		for _, ch := range chapters {
			existing[ch.ID] = true
		}
		acts, changed, _ := sanitizeOutlineBindings(acts, existing)

		// 2) Title rebind: content chapters first, then empty shells, so real
		// work wins duplicate-title matches.
		sorted := make([]model.Chapter, len(chapters))
		copy(sorted, chapters)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].WordCount > sorted[j].WordCount })
		for _, ch := range sorted {
			if chapterReferenced(acts, ch.ID) {
				continue
			}
			if bindChapterByTitle(acts, ch) {
				changed = true
			}
		}
		// Recompute the outline-ordered bound ids after rebinding so the
		// position resync below reflects the repaired bindings.
		_, _, boundOrder := sanitizeOutlineBindings(acts, existing)

		// 3) Persist the repaired outline, then delete whatever is still
		// unreferenced (deprecated article-library data).
		if changed {
			out, err := json.Marshal(acts)
			if err == nil {
				// No dedupOutlineActs: same reason as bindChaptersToOutline.
				if err := s.docRepo.UpsertOutline(ctx, &model.NovelOutline{
					UserID: n.UserID, NovelID: n.ID, Acts: datatypes.JSON(out),
				}); err != nil {
					zap.L().Warn("orphan-chapter cleanup: persist repaired outline failed",
						zap.Int64("novel_id", n.ID), zap.Error(err))
				}
			}
		}
		removed := 0
		for _, ch := range chapters {
			if chapterReferenced(acts, ch.ID) {
				continue // bound in outline manager — keep
			}
			if err := s.chapterRepo.Delete(ctx, n.UserID, ch.ID); err != nil {
				zap.L().Warn("orphan-chapter cleanup: delete failed",
					zap.Int64("novel_id", n.ID), zap.Int64("chapter_id", ch.ID), zap.Error(err))
				continue
			}
			removed++
		}
		// 4) Resync positions to outline order (备忘录 L57). Re-read after the
		// orphan deletes so the surviving set drives the rewrite.
		if survivors, serr := s.chapterRepo.ListByNovelID(ctx, n.UserID, n.ID); serr == nil {
			if rerr := s.resyncChapterPositionsToOutline(ctx, n.UserID, n.ID, boundOrder, survivors); rerr != nil {
				zap.L().Warn("orphan-chapter cleanup: resync positions failed",
					zap.Int64("novel_id", n.ID), zap.Error(rerr))
			}
		}
		if removed == 0 {
			continue
		}
		deleted += removed
		if err := s.chapterRepo.RefreshNovelWordCount(ctx, n.UserID, n.ID); err != nil {
			zap.L().Warn("orphan-chapter cleanup: refresh word_count failed",
				zap.Int64("novel_id", n.ID), zap.Error(err))
		}
	}
	if deleted > 0 {
		zap.L().Info("orphan-chapter cleanup removed deprecated article-library chapters",
			zap.Int("deleted", deleted))
	}
	return deleted, nil
}

// bindChaptersToOutline binds the given chapters into the outline acts and
// persists the updated document (version bump via UpsertOutline; the soft
// client version check does not apply to server-side binding). Returns the
// updated acts JSON with the current version, or the original acts when
// nothing changed.
func (s *NovelDocService) bindChaptersToOutline(ctx context.Context, userID, novelID int64, chapters []model.Chapter) (json.RawMessage, int, error) {
	doc, err := s.docRepo.GetOutline(ctx, userID, novelID)
	if err != nil {
		return nil, 0, err
	}
	acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(doc.Acts)))
	if !ok {
		acts = []map[string]any{}
	}
	changed := false
	for _, ch := range chapters {
		if chapterReferenced(acts, ch.ID) {
			continue // idempotent: already bound somewhere in the outline
		}
		if bindChapterByTitle(acts, ch) {
			changed = true
			continue
		}
		acts = appendChapterNode(acts, ch)
		changed = true
	}
	if !changed {
		return json.RawMessage(doc.Acts), doc.Version, nil
	}
	out, err := json.Marshal(acts)
	if err != nil {
		return nil, 0, err
	}
	// No dedupOutlineActs here: mergeOutlineAct drops same-title nodes, which
	// would silently discard a just-appended binding for a duplicate-titled
	// chapter and turn the read boundary into a binding loop.
	upsert := &model.NovelOutline{UserID: userID, NovelID: novelID, Acts: datatypes.JSON(out)}
	if err := s.docRepo.UpsertOutline(ctx, upsert); err != nil {
		return nil, 0, err
	}
	return out, upsert.Version, nil
}

// parseOutlineActs decodes normalized acts JSON into a mutable act map slice.
func parseOutlineActs(raw json.RawMessage) ([]map[string]any, bool) {
	var acts []map[string]any
	if len(raw) == 0 {
		return []map[string]any{}, true
	}
	if err := json.Unmarshal(raw, &acts); err != nil {
		return nil, false
	}
	return acts, true
}

// chapterReferenced reports whether any outline node already binds chapterID.
func chapterReferenced(acts []map[string]any, chapterID int64) bool {
	want := float64(chapterID)
	for _, act := range acts {
		for _, n := range actNodes(act) {
			if n == nil {
				continue
			}
			if id, _ := n["chapter_id"].(float64); id == want {
				return true
			}
		}
	}
	return false
}

// bindChapterByTitle binds chapterID into the FIRST unbound node whose title
// matches the chapter title (ordinal-insensitive, quote-stripped). A planned
// node bumps to drafting when the chapter carries content; done/drafting stay.
func bindChapterByTitle(acts []map[string]any, ch model.Chapter) bool {
	key := chapterTitleKey(ch.Title)
	if key == "" {
		return false
	}
	for _, act := range acts {
		for _, n := range actNodes(act) {
			if n == nil {
				continue
			}
			if _, bound := n["chapter_id"]; bound {
				continue
			}
			if chapterTitleKey(n["title"]) != key {
				continue
			}
			n["chapter_id"] = float64(ch.ID)
			if status, _ := n["status"].(string); status == outlineStatusPlanned && ch.WordCount > 0 {
				n["status"] = outlineStatusDrafting
			}
			return true
		}
	}
	return false
}

// appendChapterNode appends a new outline node for the chapter to the last act,
// creating a "第一幕" act when the outline has none. Always returns the acts
// slice (it is reallocated when the outline was empty). Writing status is
// two-state: a chapter carrying content lands as drafting, empty as drafting
// too — legacy "planned" is no longer written.
func appendChapterNode(acts []map[string]any, ch model.Chapter) []map[string]any {
	status := outlineStatusDrafting
	node := map[string]any{
		"id":         idgen.NewID(),
		"title":      ch.Title,
		"summary":    "",
		"status":     status,
		"chapter_id": float64(ch.ID),
	}
	if len(acts) == 0 {
		return append(acts, map[string]any{
			"id":    idgen.NewID(),
			"title": "第一幕",
			"nodes": []map[string]any{node},
		})
	}
	last := acts[len(acts)-1]
	nodes := actNodes(last)
	last["nodes"] = append(nodes, node)
	return acts
}

// sanitizeOutlineBindings enforces the one-chapter-per-node invariant (备忘录
// L57/59: 大纲与章节唯一绑定) and repairs the two corruptions that produced the
// wrong "第N章" numbering:
//
//   - phantom bindings: a node whose chapter_id points at a chapter that no
//     longer exists (the web DEV-mock create path used to mint Date.now() ids
//     and save them straight into the outline) — the binding is dropped;
//   - duplicate bindings: the same chapter bound by several nodes — only the
//     first node keeps the binding, later ones are cleared.
//
// Returns the (possibly mutated) acts, whether anything changed, and the
// outline-ordered list of still-valid bound chapter ids (acts→nodes array order).
func sanitizeOutlineBindings(acts []map[string]any, existing map[int64]bool) ([]map[string]any, bool, []int64) {
	changed := false
	seen := make(map[int64]bool, len(acts))
	boundOrder := make([]int64, 0, len(acts))
	for _, act := range acts {
		for _, node := range actNodes(act) {
			if node == nil {
				continue
			}
			idf, ok := node["chapter_id"].(float64)
			if !ok {
				continue
			}
			id := int64(idf)
			if !existing[id] || seen[id] {
				delete(node, "chapter_id")
				changed = true
				continue
			}
			seen[id] = true
			boundOrder = append(boundOrder, id)
		}
	}
	return acts, changed, boundOrder
}

// resyncChapterPositionsToOutline rewrites chapters.position so it always
// mirrors outline order (备忘录 L57): chapters bound to outline nodes come
// first in acts→nodes array order, unbound chapters follow in their current
// order. This is the single fix for the "第0章 / 第19章" misnumbering — the
// display layer reads position, and position was an ad-hoc auto-increment that
// drifted from the outline. The write is skipped when positions already match,
// so ordinary saves don't churn updated_at. chapters must be position-ascending.
func (s *NovelDocService) resyncChapterPositionsToOutline(
	ctx context.Context, userID, novelID int64, boundOrder []int64, chapters []model.Chapter,
) error {
	if len(chapters) == 0 {
		return nil
	}
	byID := make(map[int64]bool, len(chapters))
	for _, c := range chapters {
		byID[c.ID] = true
	}
	ordered := make([]int64, 0, len(chapters))
	placed := make(map[int64]bool, len(chapters))
	for _, id := range boundOrder {
		if byID[id] && !placed[id] {
			ordered = append(ordered, id)
			placed[id] = true
		}
	}
	for _, c := range chapters {
		if !placed[c.ID] {
			ordered = append(ordered, c.ID)
			placed[c.ID] = true
		}
	}
	// Already in outline order: nothing to do.
	drifted := false
	for i := range ordered {
		if chapters[i].ID != ordered[i] {
			drifted = true
			break
		}
	}
	if !drifted {
		return nil
	}
	return s.chapterRepo.ReorderByIDs(ctx, userID, novelID, ordered)
}

// SyncOutlineChapterOrder enforces the outline↔chapter invariants after a
// web-panel outline save (备忘录 L57/59): drop phantom / duplicate chapter_id
// bindings (one chapter per node), persist the repaired outline, then rewrite
// chapters.position to mirror the outline order so "第N章" numbering stops
// drifting.
//
// It is deliberately a SEPARATE call from UpdateOutline — the whole-novel
// version restore writes the outline inside a DB transaction and must not have
// chapter-repo reads / a nested reordering transaction interleaved with it
// (SQLite shared-cache write lock). The web PUT handler runs it after a
// committed UpdateOutline, outside any transaction.
func (s *NovelDocService) SyncOutlineChapterOrder(ctx context.Context, userID, novelID int64) error {
	if s == nil || s.chapterRepo == nil || s.docRepo == nil {
		return nil
	}
	doc, err := s.docRepo.GetOutline(ctx, userID, novelID)
	if err != nil {
		return err
	}
	acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(doc.Acts)))
	if !ok {
		return nil
	}
	chapters, cerr := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if cerr != nil {
		return cerr
	}
	existing := make(map[int64]bool, len(chapters))
	for _, ch := range chapters {
		existing[ch.ID] = true
	}
	acts, changed, boundOrder := sanitizeOutlineBindings(acts, existing)
	if changed {
		out, merr := json.Marshal(acts)
		if merr != nil {
			return merr
		}
		if uerr := s.docRepo.UpsertOutline(ctx, &model.NovelOutline{
			UserID: userID, NovelID: novelID, Acts: datatypes.JSON(out),
		}); uerr != nil {
			return uerr
		}
	}
	return s.resyncChapterPositionsToOutline(ctx, userID, novelID, boundOrder, chapters)
}
