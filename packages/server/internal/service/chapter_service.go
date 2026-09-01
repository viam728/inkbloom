package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"github.com/jackc/pgx/v5/pgconn"
	"go.uber.org/zap"
	"gorm.io/datatypes"
)

// ErrInvalidInput is returned when request parameters are semantically invalid.
var ErrInvalidInput = errors.New("invalid input")

// ChapterService handles chapter business logic.
type ChapterService struct {
	chapterRepo repository.ChapterRepository
	novelRepo   repository.NovelRepository
	cache       *cache.CacheManager
	// E1 version history (business plan v3). versionRepo is optional: when
	// nil the service behaves exactly as before, which keeps existing tests
	// and local-mode wiring working without the new dependency.
	versionRepo repository.ChapterVersionRepository
	versionCfg  config.VersionHistoryConfig
}

// NewChapterService creates a new ChapterService.
func NewChapterService(cr repository.ChapterRepository, nr repository.NovelRepository, cm *cache.CacheManager, vr repository.ChapterVersionRepository, vh config.VersionHistoryConfig) *ChapterService {
	return &ChapterService{chapterRepo: cr, novelRepo: nr, cache: cm, versionRepo: vr, versionCfg: vh}
}

// snapshotBeforeUpdate writes an automatic snapshot of the chapter's current
// (pre-update) content when the E1 auto-snapshot policy allows it.
//
// Two guards keep the version table from exploding on a long writing session:
//   - throttle: no snapshot if the previous one is younger than the configured
//     interval (default 5 min);
//   - dedupe: no snapshot if the content hash is unchanged since the last one.
//
// Snapshotting is best-effort by design: a failure here must never block the
// author's save, so every error is logged and swallowed (plan A03).
func (s *ChapterService) snapshotBeforeUpdate(ctx context.Context, userID int64, chapter *model.Chapter) {
	if s.versionRepo == nil || !s.versionCfg.Enabled {
		return
	}
	if chapter.Content == nil {
		return
	}

	content := *chapter.Content
	hash := contentHash(content)

	latest, err := s.versionRepo.Latest(ctx, userID, chapter.ID)
	if err != nil {
		zap.L().Warn("version history: latest snapshot lookup failed",
			zap.Int64("chapter_id", chapter.ID), zap.Error(err))
		return
	}

	interval := time.Duration(s.versionCfg.AutoIntervalMinutes) * time.Minute
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	if latest != nil {
		if latest.ContentHash == hash {
			return // content unchanged since the last snapshot
		}
		if time.Since(latest.CreatedAt) < interval {
			return // inside the throttle window
		}
	}

	v := &model.ChapterVersion{
		UserID:      userID,
		ChapterID:   chapter.ID,
		NovelID:     chapter.NovelID,
		Title:       chapter.Title,
		Content:     chapter.Content,
		ContentJSON: chapter.ContentJSON,
		WordCount:   chapter.WordCount,
		Kind:        model.VersionKindAuto,
		ContentHash: hash,
	}
	if err := s.versionRepo.Create(ctx, v); err != nil {
		zap.L().Warn("version history: auto snapshot failed",
			zap.Int64("chapter_id", chapter.ID), zap.Error(err))
		return
	}

	if _, err := s.versionRepo.PruneAuto(ctx, userID, chapter.ID, s.versionCfg.AutoKeepPerChapter); err != nil {
		zap.L().Warn("version history: auto snapshot prune failed",
			zap.Int64("chapter_id", chapter.ID), zap.Error(err))
	}
}

// SnapshotForAgent captures the chapter's current content before an Agent
// mutation is applied, so an Agent write is always recoverable through the
// existing version-history infra (plan §七.3.1 "写前自动快照"). It reuses the
// chapter_versions table and the VersionKindAuto kind, but with the label
// "agent-auto" so the snapshot is attributable to the Agent guard.
//
// Best-effort by design: a failure here must never block or error the calling
// Agent write, so every error is logged and swallowed. Unlike snapshotBeforeUpdate
// it applies no throttle window — agent writes are each captured when the content
// differs from the most recent snapshot.
func (s *ChapterService) SnapshotForAgent(ctx context.Context, userID, chapterID int64) {
	if s.versionRepo == nil || !s.versionCfg.Enabled {
		return
	}
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		zap.L().Warn("agent snapshot: chapter lookup failed",
			zap.Int64("chapter_id", chapterID), zap.Error(err))
		return
	}
	if chapter == nil {
		return
	}
	if chapter.Content == nil {
		// Empty chapter: nothing meaningful to snapshot yet.
		return
	}

	hash := contentHash(*chapter.Content)
	latest, err := s.versionRepo.Latest(ctx, userID, chapter.ID)
	if err != nil {
		zap.L().Warn("agent snapshot: latest lookup failed",
			zap.Int64("chapter_id", chapter.ID), zap.Error(err))
		return
	}
	if latest != nil && latest.ContentHash == hash {
		return // identical to the most recent snapshot — skip
	}

	v := &model.ChapterVersion{
		UserID:      userID,
		ChapterID:   chapter.ID,
		NovelID:     chapter.NovelID,
		Title:       chapter.Title,
		Content:     chapter.Content,
		ContentJSON: chapter.ContentJSON,
		WordCount:   chapter.WordCount,
		Kind:        model.VersionKindAuto,
		Label:       "agent-auto",
		ContentHash: hash,
	}
	if err := s.versionRepo.Create(ctx, v); err != nil {
		zap.L().Warn("agent snapshot: create failed",
			zap.Int64("chapter_id", chapter.ID), zap.Error(err))
		return
	}
}

// contentHash returns the leading 16 hex chars of sha256(content), used for
// snapshot dedupe. 16 chars (64 bits) is ample here: collisions would only
// cause a missed snapshot, never data loss.
func contentHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])[:16]
}

// CreateChapter creates a new chapter and returns the response DTO. The
// owning novel is verified within the user's scope.
func (s *ChapterService) CreateChapter(ctx context.Context, userID int64, req *dto.CreateChapterRequest) (*dto.ChapterResponse, error) {
	// Verify the novel exists and belongs to the user
	novel, err := s.novelRepo.GetByID(ctx, userID, req.NovelID)
	if err != nil {
		return nil, err
	}
	if novel == nil {
		return nil, ErrNotFound
	}

	// Calculate next position
	maxPos, err := s.chapterRepo.GetMaxPosition(ctx, userID, req.NovelID)
	if err != nil {
		return nil, err
	}

	chapter := &model.Chapter{
		UserID:   userID,
		NovelID:  req.NovelID,
		VolumeID: req.VolumeID,
		Title:    req.Title,
		Position: maxPos + 1,
		Status:   "draft",
	}
	if req.Content != "" {
		chapter.Content = &req.Content
		chapter.WordCount = countWords(req.Content)
	}

	if req.Position != nil {
		// 0-based insertion index (frontend contract). Clamp out-of-range
		// values: negatives to the head, beyond-the-end to the tail.
		pos := *req.Position
		if pos < 0 {
			pos = 0
		}
		if end := maxPos + 1; pos > end {
			pos = end
		}
		err = s.chapterRepo.CreateAtPosition(ctx, userID, chapter, pos)
		if isUniqueViolation(err) {
			// Concurrent insert raced on the partial unique index; retry once.
			zap.L().Warn("chapter insert hit unique-index conflict, retrying once",
				zap.Int64("novel_id", req.NovelID), zap.Int("position", pos), zap.Error(err))
			chapter.ID = 0
			err = s.chapterRepo.CreateAtPosition(ctx, userID, chapter, pos)
		}
		if err != nil {
			zap.L().Error("failed to create chapter at position",
				zap.Int64("novel_id", req.NovelID), zap.Int("position", pos), zap.Error(err))
			return nil, err
		}
		return toChapterResponse(chapter), nil
	}

	if err := s.chapterRepo.Create(ctx, chapter); err != nil {
		zap.L().Error("failed to create chapter", zap.Int64("novel_id", req.NovelID), zap.Error(err))
		return nil, err
	}
	return toChapterResponse(chapter), nil
}

// ReorderChapters rewrites chapter positions to 0..n-1 following orderedIDs.
// Idempotent: the last complete ordered list wins.
func (s *ChapterService) ReorderChapters(ctx context.Context, userID, novelID int64, orderedIDs []int64) error {
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		zap.L().Error("failed to fetch novel for reorder", zap.Int64("novel_id", novelID), zap.Error(err))
		return err
	}
	if novel == nil {
		return ErrNotFound
	}

	// Deduplicate ids, keeping the first occurrence order.
	seen := make(map[int64]struct{}, len(orderedIDs))
	ids := make([]int64, 0, len(orderedIDs))
	for _, id := range orderedIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ErrInvalidInput
	}

	if err := s.chapterRepo.ReorderByIDs(ctx, userID, novelID, ids); err != nil {
		zap.L().Error("failed to reorder chapters",
			zap.Int64("novel_id", novelID), zap.Int("count", len(ids)), zap.Error(err))
		return err
	}
	return nil
}

// GetChapter retrieves a chapter by ID within the user's scope (with cache).
func (s *ChapterService) GetChapter(ctx context.Context, userID, id int64) (*dto.ChapterResponse, error) {
	key := fmt.Sprintf(cache.ChapterContent, userID, id)
	var resp dto.ChapterResponse

	err := s.cache.GetWithNullCache(ctx, key, &resp, cache.ChapterTTL, func() (interface{}, error) {
		chapter, err := s.chapterRepo.GetByID(ctx, userID, id)
		if err != nil {
			return nil, err
		}
		if chapter == nil {
			return nil, nil
		}
		return toChapterResponse(chapter), nil
	})

	if errors.Is(err, cache.ErrNullCached) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// ListChaptersByNovel lists all chapters for a given novel within the user's scope.
func (s *ChapterService) ListChaptersByNovel(ctx context.Context, userID, novelID int64) ([]dto.ChapterResponse, error) {
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}

	responses := make([]dto.ChapterResponse, 0, len(chapters))
	for i := range chapters {
		responses = append(responses, *toChapterResponse(&chapters[i]))
	}
	return responses, nil
}

// GetChapterByTitle resolves a chapter by a (possibly ordinal-wrapped) title or
// keyword within the user's scope, returning the BEST match. It normalizes both
// the query and each chapter title with outlineTitleKey (which already strips a
// leading "第N章" prefix and 《》 brackets), so "第48章《余生长歌》" resolves to a
// chapter whose raw title is "余生长歌" (or contains it). Match priority:
//  1. exact normalized title match wins;
//  2. else a normalized substring/containment match wins;
//  3. else nil is returned.
//
// All repo access is user-scoped (contract C3) via ListByNovelID.
func (s *ChapterService) GetChapterByTitle(ctx context.Context, userID, novelID int64, title string) (*dto.ChapterResponse, error) {
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	query := outlineTitleKey(title)
	if query == "" {
		return nil, nil
	}
	var exact *dto.ChapterResponse
	var partial *dto.ChapterResponse
	for i := range chapters {
		ch := toChapterResponse(&chapters[i])
		norm := outlineTitleKey(ch.Title)
		if norm == "" {
			continue
		}
		if norm == query {
			if exact == nil {
				exact = ch
			}
			continue
		}
		if strings.Contains(norm, query) || strings.Contains(query, norm) {
			if partial == nil {
				partial = ch
			}
		}
	}
	if exact != nil {
		return exact, nil
	}
	if partial != nil {
		return partial, nil
	}
	return nil, nil
}

// UpdateChapter updates an existing chapter within the user's scope.
func (s *ChapterService) UpdateChapter(ctx context.Context, userID, id int64, req *dto.UpdateChapterRequest) (*dto.ChapterResponse, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	// E1 (business plan v3, plan A03): snapshot the pre-update content before
	// any field is overwritten. This single hook covers every write path —
	// editor autosave, title rename, API clients — with no frontend change.
	if req.Content != nil {
		s.snapshotBeforeUpdate(ctx, userID, chapter)
	}

	if req.Title != nil {
		chapter.Title = *req.Title
	}
	if req.Content != nil {
		chapter.Content = req.Content
		chapter.WordCount = countWords(*req.Content)
	}
	if req.ContentJSON != nil {
		chapter.ContentJSON = datatypes.JSON(*req.ContentJSON)
	}
	if req.Summary != nil {
		chapter.Summary = req.Summary
	}
	if req.Status != nil {
		chapter.Status = *req.Status
	}

	if err := s.chapterRepo.Update(ctx, userID, chapter); err != nil {
		zap.L().Error("failed to update chapter", zap.Int64("chapter_id", id), zap.Error(err))
		return nil, err
	}
	// Invalidate cache after update
	_ = s.cache.Delete(ctx, fmt.Sprintf(cache.ChapterContent, userID, id))

	// Content changed: refresh the aggregated novel word count. Failure is
	// non-blocking — the chapter save itself already succeeded.
	if req.Content != nil {
		if err := s.chapterRepo.RefreshNovelWordCount(ctx, userID, chapter.NovelID); err != nil {
			zap.L().Warn("failed to refresh novel word_count after content save",
				zap.Int64("novel_id", chapter.NovelID), zap.Int64("chapter_id", id), zap.Error(err))
		}
	}
	return toChapterResponse(chapter), nil
}

// DeleteChapter deletes a chapter by ID within the user's scope.
func (s *ChapterService) DeleteChapter(ctx context.Context, userID, id int64) error {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, id)
	if err != nil {
		return err
	}
	if chapter == nil {
		return ErrNotFound
	}
	err = s.chapterRepo.Delete(ctx, userID, id)
	if err == nil {
		_ = s.cache.Delete(ctx, fmt.Sprintf(cache.ChapterContent, userID, id))
	}
	return err
}

// isUniqueViolation reports whether err is a PostgreSQL unique-constraint
// violation (SQLSTATE 23505), e.g. from uniq_chapters_novel_position.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// countWords counts the number of Chinese characters / runes in text.
func countWords(text string) int {
	return utf8.RuneCountInString(text)
}

func toChapterResponse(c *model.Chapter) *dto.ChapterResponse {
	resp := &dto.ChapterResponse{
		ID:        c.ID,
		NovelID:   c.NovelID,
		VolumeID:  c.VolumeID,
		Title:     c.Title,
		WordCount: c.WordCount,
		Position:  c.Position,
		// SortOrder 前端兼容别名，与 Position 同值，下迭代收敛。
		SortOrder: c.Position,
		Status:    c.Status,
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
	}
	if c.Content != nil {
		resp.Content = *c.Content
	}
	if c.Summary != nil {
		resp.Summary = *c.Summary
	}
	if len(c.ContentJSON) > 0 {
		resp.ContentJSON = json.RawMessage(c.ContentJSON)
	}
	return resp
}
