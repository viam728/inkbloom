package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/pkg/contentsanitize"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"go.uber.org/zap"
)

// slugPattern constrains published-work slugs: lowercase ascii with hyphens,
// bookended by alphanumerics.
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,118}[a-z0-9]$`)

// PublishService owns the E4 publishing operations (plan A17).
type PublishService struct {
	workRepo        repository.PublishedRepository
	readRepo        repository.PublishedReadRepository
	chapterRepo     repository.ChapterRepository
	novelRepo       repository.NovelRepository
	versionRepo     repository.ChapterVersionRepository
	ledgerRepo      repository.TokenLedgerRepository
	interactionRepo repository.InteractionRepository
	history         *HistoryService
	cs              contentsafety.Checker
	cache           *cache.CacheManager
	localMode       bool
}

// NewPublishService creates a new PublishService.
func NewPublishService(
	wr repository.PublishedRepository,
	rr repository.PublishedReadRepository,
	cr repository.ChapterRepository,
	nr repository.NovelRepository,
	vr repository.ChapterVersionRepository,
	lr repository.TokenLedgerRepository,
	ir repository.InteractionRepository,
	h *HistoryService,
	cs contentsafety.Checker,
	cm *cache.CacheManager,
	localMode bool,
) *PublishService {
	return &PublishService{
		workRepo: wr, readRepo: rr, chapterRepo: cr, novelRepo: nr,
		versionRepo: vr, ledgerRepo: lr, interactionRepo: ir, history: h, cs: cs, cache: cm, localMode: localMode,
	}
}

// ListMyWorks returns the author's published works.
func (s *PublishService) ListMyWorks(ctx context.Context, userID int64) ([]dto.WorkResponse, error) {
	list, err := s.workRepo.ListWorksByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]dto.WorkResponse, 0, len(list))
	for i := range list {
		out = append(out, toWorkResponse(&list[i]))
	}
	return out, nil
}

// CreateWork publishes a novel for the first time.
func (s *PublishService) CreateWork(ctx context.Context, userID int64, req *dto.CreateWorkRequest) (*dto.WorkResponse, error) {
	// The novel must belong to the author (C3) and not already be published.
	novel, err := s.novelRepo.GetByID(ctx, userID, req.NovelID)
	if err != nil {
		return nil, err
	}
	if novel == nil {
		return nil, ErrNotFound
	}
	existing, err := s.workRepo.WorkByNovel(ctx, userID, req.NovelID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrAlreadyPublished
	}

	visibility := req.Visibility
	if visibility == "" {
		visibility = model.VisibilityPublic
	}
	slug, err := s.resolveSlug(ctx, req.Slug, req.Title, req.NovelID)
	if err != nil {
		return nil, err
	}

	w := &model.PublishedWork{
		UserID: userID, NovelID: req.NovelID, Slug: slug,
		Title: req.Title, Synopsis: req.Synopsis, CoverURL: req.CoverURL,
		Visibility: visibility,
	}
	if err := s.workRepo.CreateWork(ctx, w); err != nil {
		// TOCTOU (F1-7): the slug may have been taken between SlugExists and
		// CreateWork — the unique index is the arbiter. Retry the derivation
		// once for derived slugs so concurrent publishes of similar titles
		// land with suffixed slugs instead of a raw 500.
		if isUniqueViolation(err) && req.Slug == "" {
			retry, rerr := s.resolveSlug(ctx, "", req.Title, req.NovelID)
			if rerr != nil {
				return nil, ErrSlugTaken
			}
			w.Slug = retry
			if cerr := s.workRepo.CreateWork(ctx, w); cerr != nil {
				return nil, ErrSlugTaken
			}
		} else if isUniqueViolation(err) {
			return nil, ErrSlugTaken
		} else {
			return nil, err
		}
	}
	resp := toWorkResponse(w)
	s.fillAIInspired(ctx, &resp, userID, req.NovelID)
	return &resp, nil
}

// UpdateWork edits an already-published work's metadata.
func (s *PublishService) UpdateWork(ctx context.Context, userID, workID int64, req *dto.UpdateWorkRequest) (*dto.WorkResponse, error) {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, ErrNotFound
	}
	if req.Title != nil {
		w.Title = *req.Title
	}
	if req.Synopsis != nil {
		w.Synopsis = *req.Synopsis
	}
	if req.CoverURL != nil {
		w.CoverURL = *req.CoverURL
	}
	if req.Visibility != nil {
		w.Visibility = *req.Visibility
	}
	if err := s.workRepo.UpdateWork(ctx, userID, w); err != nil {
		return nil, err
	}
	resp := toWorkResponse(w)
	s.fillAIInspired(ctx, &resp, userID, w.NovelID)
	return &resp, nil
}

// Unpublish removes a work from the public surface. The row is deleted (not
// just flipped to private) so the slug frees up; readers lose access
// immediately. Re-publishing creates a fresh slug and empty follow count.
func (s *PublishService) Unpublish(ctx context.Context, userID, workID int64) error {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return err
	}
	if w == nil {
		return ErrNotFound
	}
	return s.workRepo.DeleteWork(ctx, userID, workID)
}

// PublishChapter publishes one chapter: content-safety check → HTML
// sanitise → write a milestone snapshot → copy the sanitised body into
// published_chapters with the snapshot's id as VersionID.
//
// The snapshot is what makes publication auditable: "which draft state did
// readers see" stays answerable forever, because published_chapters is a
// frozen copy and chapter_versions keeps the milestone it came from.
func (s *PublishService) PublishChapter(ctx context.Context, userID, workID int64, req *dto.PublishChapterRequest) (*dto.PublishedChapterResponse, error) {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, ErrNotFound
	}
	chapter, err := s.chapterRepo.GetByID(ctx, userID, req.ChapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	// C12: every piece of released UGC passes the content-safety checker.
	// A NoopChecker (the default) passes everything; only a configured
	// provider actually inspects. Failing open on checker errors would let
	// an outage mask a violation, so we fail closed here instead.
	title := chapter.Title
	body := derefStr(chapter.Content)
	if s.cs != nil {
		if res, err := s.cs.CheckText(contentsafety.WithEndpoint(ctx, "/api/v1/publish/chapters"), title+" "+body); err != nil {
			return nil, fmt.Errorf("content safety check error: %w", err)
		} else if !res.Pass {
			return nil, contentsafety.ErrContentRejected
		}
	}

	// XSS defence: strip the body to the safe whitelist before storing the
	// public copy. The draft keeps its original markup; only what readers
	// see is sanitised.
	sanitised := contentsanitize.SafeHTML(body)

	// 发布版本唯一化：一章只保留一条发布 milestone。重发=覆盖读者快照，
	// 旧的发布快照已被新发布取代，留在历史面板里只会堆积成多条重复的
	// 「发布《…》」条目。先清旧的再写新的；用户自建 milestone（其它 label）
	// 与 auto / rollback 版本不受影响。
	if _, derr := s.versionRepo.DeletePublishMilestones(ctx, userID, req.ChapterID); derr != nil {
		return nil, derr
	}

	// Snapshot the current draft as a milestone so the published version is
	// traceable. 章节次序的唯一权威是大纲序，任何把「第N章」烧进 label 的
	// 文本都会在重排后变成脏数据（第19章问题根因），label 只带作品名。
	label := fmt.Sprintf("发布《%s》", w.Title)
	snap, err := s.history.CreateSnapshot(ctx, userID, req.ChapterID, &dto.CreateVersionRequest{
		Kind: model.VersionKindMilestone, Label: label,
	})
	if err != nil {
		return nil, err
	}

	var versionID *int64
	if snap != nil {
		versionID = &snap.ID
	}

	pc := &model.PublishedChapter{
		UserID: userID, WorkID: workID, ChapterID: req.ChapterID,
		VersionID: versionID, Title: title,
		Content: &sanitised, ContentFormat: model.ContentFormatHTML,
		WordCount: chapter.WordCount, Position: chapter.Position,
		ScheduledAt: req.ScheduledAt,
	}
	if err := s.workRepo.UpsertChapter(ctx, userID, pc); err != nil {
		return nil, err
	}
	resp := toPubChapterResponse(pc)
	return &resp, nil
}

// UnpublishChapter takes one chapter off the public surface.
func (s *PublishService) UnpublishChapter(ctx context.Context, userID, pid int64) error {
	pc, err := s.workRepo.ChapterByPublishedID(ctx, userID, pid)
	if err != nil {
		return err
	}
	if pc == nil {
		return ErrNotFound
	}
	return s.workRepo.DeleteChapter(ctx, userID, pid)
}

// ListWorkChapters returns the author's published chapters of one work — the
// system-of-record the web "已发布" badge derives from (publish status is
// system-managed, never user-editable).
func (s *PublishService) ListWorkChapters(ctx context.Context, userID, workID int64) ([]model.PublishedChapter, error) {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, ErrNotFound
	}
	return s.workRepo.ListChaptersByWork(ctx, userID, workID)
}

// ── 版本管理（备忘录 L61 三态：草稿/发布两份在服务器，临时只在浏览器） ──

// VersionsSummary returns the two server-side version states of a chapter:
// draft (chapters.content working copy) and published (published_chapters
// full copy + 快照指针 version_id → chapter_versions milestone).
func (s *PublishService) VersionsSummary(ctx context.Context, userID, chapterID int64) (*dto.VersionPanelSummary, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}
	out := &dto.VersionPanelSummary{
		Draft: dto.VersionBranchSummary{
			Exists:    true,
			WordCount: chapter.WordCount,
			UpdatedAt: chapter.UpdatedAt,
		},
	}
	pc, err := s.workRepo.ChapterPublishedByChapterID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if pc != nil {
		updatedAt := pc.PublishedAt
		out.Published = &dto.VersionBranchSummary{
			Exists:    true,
			VersionID: pc.VersionID,
			WordCount: pc.WordCount,
			UpdatedAt: updatedAt,
		}
	}
	return out, nil
}

// VersionsBranchContent returns the body of one version state: draft =
// chapters.content; published = the frozen published_chapters copy.
func (s *PublishService) VersionsBranchContent(ctx context.Context, userID, chapterID int64, branch string) (string, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return "", err
	}
	if chapter == nil {
		return "", ErrNotFound
	}
	if branch == "draft" {
		if chapter.Content == nil {
			return "", nil
		}
		return *chapter.Content, nil
	}
	pc, err := s.workRepo.ChapterPublishedByChapterID(ctx, userID, chapterID)
	if err != nil {
		return "", err
	}
	if pc == nil || pc.Content == nil {
		return "", nil
	}
	return *pc.Content, nil
}

// CheckoutPublishedVersion rolls the draft back to the published body: the
// frozen published copy is copied into chapters.content (草稿工作区被覆盖，
// 调用方先把当前草稿压入浏览器临时分支，保证可撤销)。
func (s *PublishService) CheckoutPublishedVersion(ctx context.Context, userID, chapterID int64) (string, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return "", err
	}
	if chapter == nil {
		return "", ErrNotFound
	}
	pc, err := s.workRepo.ChapterPublishedByChapterID(ctx, userID, chapterID)
	if err != nil {
		return "", err
	}
	if pc == nil || pc.Content == nil {
		return "", ErrNotFound
	}
	content := *pc.Content
	chapter.Content = &content
	chapter.WordCount = countWords(content)
	if err := s.chapterRepo.Update(ctx, userID, chapter); err != nil {
		return "", err
	}
	// 关键：失效章节正文缓存。不失效的话回滚后 3 分钟内 GET /content 仍命中
	// 旧缓存，前端把旧草稿灌回编辑器 —— 「回滚未稳定覆盖草稿」的根因。
	if s.cache != nil {
		_ = s.cache.Delete(ctx, fmt.Sprintf(cache.ChapterContent, userID, chapterID))
	}
	if err := s.chapterRepo.RefreshNovelWordCount(ctx, userID, chapter.NovelID); err != nil {
		zap.L().Warn("failed to refresh novel word_count after version checkout",
			zap.Int64("novel_id", chapter.NovelID), zap.Int64("chapter_id", chapterID), zap.Error(err))
	}
	return content, nil
}

// GetWorkStats returns the author's read-statistics for a work (plan A23):
// follow count, distinct readers, and the per-chapter read-through funnel.
func (s *PublishService) GetWorkStats(ctx context.Context, userID, workID int64) (*dto.WorkStatsResponse, error) {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, ErrNotFound
	}
	chapters, err := s.workRepo.ListChaptersByWork(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	dist, err := s.readRepo.ReadingDistribution(ctx, workID)
	if err != nil {
		return nil, err
	}
	readers, err := s.readRepo.DistinctReaders(ctx, workID)
	if err != nil {
		return nil, err
	}

	counts := make(map[int64]int64, len(dist))
	for _, d := range dist {
		counts[d.ChapterID] = d.ReaderCount
	}

	out := &dto.WorkStatsResponse{
		WorkID:      workID,
		FollowCount: int64(w.FollowCount),
		ReaderCount: readers,
		Chapters:    make([]dto.ChapterStatsDTO, 0, len(chapters)),
	}
	for i := range chapters {
		out.Chapters = append(out.Chapters, dto.ChapterStatsDTO{
			ChapterID:   chapters[i].ID,
			Title:       chapters[i].Title,
			Position:    chapters[i].Position,
			ReaderCount: counts[chapters[i].ID],
		})
	}
	return out, nil
}

// ChapterEmotions returns the author's emotion aggregation for one published
// chapter (plan A31): per-block mood counts plus chapter totals. It powers
// the「章节情绪曲线」on the author dashboard — the E5 feedback loop's
// reader-side signal.
func (s *PublishService) ChapterEmotions(ctx context.Context, userID, pid int64) (*dto.ChapterEmotionsResponse, error) {
	pc, err := s.workRepo.ChapterByPublishedID(ctx, userID, pid)
	if err != nil {
		return nil, err
	}
	if pc == nil {
		return nil, ErrNotFound
	}
	moods, err := s.interactionRepo.ListByChapter(ctx, pid, model.InteractionMood)
	if err != nil {
		return nil, err
	}

	totals := map[string]int{}
	blockMap := map[int]map[string]int{}
	order := []int{}
	for i := range moods {
		var m struct {
			Mood string `json:"mood"`
		}
		if len(moods[i].Payload) == 0 {
			continue
		}
		if err := json.Unmarshal(moods[i].Payload, &m); err != nil || m.Mood == "" {
			continue
		}
		totals[m.Mood]++
		if _, ok := blockMap[moods[i].BlockIndex]; !ok {
			blockMap[moods[i].BlockIndex] = map[string]int{}
			order = append(order, moods[i].BlockIndex)
		}
		blockMap[moods[i].BlockIndex][m.Mood]++
	}
	sort.Ints(order)

	blocks := make([]dto.BlockEmotionsDTO, 0, len(order))
	for _, idx := range order {
		blocks = append(blocks, dto.BlockEmotionsDTO{BlockIndex: idx, Moods: blockMap[idx]})
	}
	return &dto.ChapterEmotionsResponse{ChapterID: pid, Totals: totals, Blocks: blocks}, nil
}

// UpdateVisibility changes a work's visibility without touching its chapters.
func (s *PublishService) UpdateVisibility(ctx context.Context, userID, workID int64, visibility string) (*dto.WorkResponse, error) {
	w, err := s.workRepo.WorkByID(ctx, userID, workID)
	if err != nil {
		return nil, err
	}
	if w == nil {
		return nil, ErrNotFound
	}
	w.Visibility = visibility
	if err := s.workRepo.UpdateWork(ctx, userID, w); err != nil {
		return nil, err
	}
	resp := toWorkResponse(w)
	s.fillAIInspired(ctx, &resp, userID, w.NovelID)
	return &resp, nil
}

// ── Reader-facing reads (used by the reader handler, A18) ────────────────────

// PublicWorkBySlug returns a work visible to anonymous readers.
func (s *PublishService) PublicWorkBySlug(ctx context.Context, slug string) (*model.PublishedWork, error) {
	return s.readRepo.WorkBySlugPublic(ctx, slug)
}

// PublicChapters lists chapters currently visible for a work.
func (s *PublishService) PublicChapters(ctx context.Context, workID int64) ([]model.PublishedChapter, error) {
	return s.readRepo.ListChaptersPublic(ctx, workID)
}

// PublicChapter returns one visible chapter, or nil if not visible.
func (s *PublishService) PublicChapter(ctx context.Context, pid int64) (*model.PublishedChapter, error) {
	return s.readRepo.ChapterPublic(ctx, pid)
}

// Discover returns the public discovery feed for the community front door.
func (s *PublishService) Discover(ctx context.Context, q string, limit, offset int) ([]dto.DiscoverWorkDTO, error) {
	rows, err := s.readRepo.DiscoverPublic(ctx, q, limit, offset)
	if err != nil {
		return nil, err
	}
	out := make([]dto.DiscoverWorkDTO, 0, len(rows))
	for i := range rows {
		out = append(out, dto.DiscoverWorkDTO{
			ID:           rows[i].ID,
			Slug:         rows[i].Slug,
			Title:        rows[i].Title,
			Synopsis:     rows[i].Synopsis,
			CoverURL:     rows[i].CoverURL,
			AIInspired:   rows[i].AIInspired,
			FollowCount:  rows[i].FollowCount,
			ChapterCount: rows[i].ChapterCount,
			AuthorName:   rows[i].AuthorName,
			UpdatedAt:    rows[i].UpdatedAt,
		})
	}
	return out, nil
}

// ── Progress & follows (reader-facing but require login, A18) ───────────────

func (s *PublishService) GetProgress(ctx context.Context, userID, workID int64) (*model.ReadingProgress, error) {
	return s.workRepo.GetProgress(ctx, userID, workID)
}

func (s *PublishService) UpsertProgress(ctx context.Context, userID, workID, chapterID int64, position float64) error {
	return s.workRepo.UpsertProgress(ctx, userID, &model.ReadingProgress{
		WorkID: workID, ChapterID: chapterID, Position: position,
	})
}

func (s *PublishService) Follow(ctx context.Context, userID, workID int64, notify bool) error {
	existing, err := s.workRepo.GetFollow(ctx, userID, workID)
	if err != nil {
		return err
	}
	if existing != nil {
		// Already following: only refresh the notify preference. Do NOT bump
		// the counter again, otherwise toggling follow on/off inflates it.
		return s.workRepo.UpsertFollow(ctx, userID, &model.ReaderFollow{WorkID: workID, Notify: notify})
	}
	if err := s.workRepo.UpsertFollow(ctx, userID, &model.ReaderFollow{WorkID: workID, Notify: notify}); err != nil {
		return err
	}
	return s.workRepo.IncFollowCount(ctx, workID)
}

// GetFollowStatus reports whether the reader already follows the work.
func (s *PublishService) GetFollowStatus(ctx context.Context, userID, workID int64) (bool, error) {
	f, err := s.workRepo.GetFollow(ctx, userID, workID)
	if err != nil {
		return false, err
	}
	return f != nil, nil
}

func (s *PublishService) Unfollow(ctx context.Context, userID, workID int64) error {
	existing, err := s.workRepo.GetFollow(ctx, userID, workID)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil // nothing to unfollow
	}
	if err := s.workRepo.DeleteFollow(ctx, userID, workID); err != nil {
		return err
	}
	return s.workRepo.DecFollowCount(ctx, workID)
}

// ── helpers ──────────────────────────────────────────────────────────────────

// resolveSlug validates a caller-supplied slug or derives one, retrying with
// a numeric suffix on collision. Up to 5 retries; after that the caller sees
// an error rather than a silent loop.
func (s *PublishService) resolveSlug(ctx context.Context, supplied, title string, novelID int64) (string, error) {
	if supplied != "" {
		if !slugPattern.MatchString(supplied) {
			return "", ErrInvalidSlug
		}
		exists, err := s.workRepo.SlugExists(ctx, 0, supplied)
		if err != nil {
			return "", err
		}
		if exists {
			return "", ErrSlugTaken
		}
		return supplied, nil
	}
	base := slugify(title)
	if base == "" {
		base = fmt.Sprintf("work-%d", novelID)
	}
	for attempt := 0; attempt < 6; attempt++ {
		candidate := base
		if attempt > 0 {
			candidate = fmt.Sprintf("%s-%d", base, attempt+1)
		}
		exists, err := s.workRepo.SlugExists(ctx, 0, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", ErrSlugTaken
}

// fillAIInspired sets the AIInspired flag and its source on the response.
//
// Primary signal: chapter_versions.kind='ai_rewrite' (precise, per-chapter —
// a snapshot is written right before every AI rewrite). Fallback: any
// token_ledger row with reason='ai_call' (user-level, may over-flag works
// whose AI edit went into a different piece). The fallback exists so a work
// isn't silently mislabelled as human-only when the precise signal is absent.
func (s *PublishService) fillAIInspired(ctx context.Context, resp *dto.WorkResponse, userID, novelID int64) {
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		zap.L().Warn("publish: listing chapters for AIInspired failed", zap.Error(err))
		return
	}
	for i := range chapters {
		has, err := s.versionRepo.ExistsAIMark(ctx, userID, chapters[i].ID)
		if err != nil {
			zap.L().Warn("publish: ExistsAIMark failed", zap.Int64("chapter_id", chapters[i].ID), zap.Error(err))
			continue
		}
		if has {
			resp.AIInspired = true
			resp.AIInspiredSource = "chapter"
			return
		}
	}
	// Fallback to the user-level signal.
	if has, err := s.ledgerRepo.HasReason(ctx, userID, model.LedgerReasonAICall); err == nil && has {
		resp.AIInspired = true
		resp.AIInspiredSource = "author"
	}
}

// slugify turns a title into a slug candidate. No pinyin dependency: Chinese
// titles fall back to a short random suffix, which is fine because the slug
// only has to be stable and unique, not pretty.
func slugify(title string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	// Collapse runs of hyphens.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

// randomSuffix produces a short hex string for slug fallback uniqueness.
func randomSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return time.Now().Format("150405")
	}
	return hex.EncodeToString(b)
}

func toWorkResponse(w *model.PublishedWork) dto.WorkResponse {
	return dto.WorkResponse{
		ID: w.ID, NovelID: w.NovelID, Slug: w.Slug, Title: w.Title,
		Synopsis: w.Synopsis, CoverURL: w.CoverURL, Visibility: w.Visibility,
		AIInspired: w.AIInspired, FollowCount: w.FollowCount,
		CreatedAt: w.CreatedAt, UpdatedAt: w.UpdatedAt,
	}
}

func toPubChapterResponse(c *model.PublishedChapter) dto.PublishedChapterResponse {
	return dto.PublishedChapterResponse{
		ID: c.ID, WorkID: c.WorkID, ChapterID: c.ChapterID, VersionID: c.VersionID,
		Title: c.Title, WordCount: c.WordCount, Position: c.Position,
		ScheduledAt: c.ScheduledAt, PublishedAt: c.PublishedAt,
	}
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Publishing-domain errors.
var (
	ErrAlreadyPublished = errors.New("novel already published")
	ErrInvalidSlug      = errors.New("invalid slug")
	ErrSlugTaken        = errors.New("slug already taken")
)
