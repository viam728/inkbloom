package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

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
}

// NewChapterService creates a new ChapterService.
func NewChapterService(cr repository.ChapterRepository, nr repository.NovelRepository, cm *cache.CacheManager) *ChapterService {
	return &ChapterService{chapterRepo: cr, novelRepo: nr, cache: cm}
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

// UpdateChapter updates an existing chapter within the user's scope.
func (s *ChapterService) UpdateChapter(ctx context.Context, userID, id int64, req *dto.UpdateChapterRequest) (*dto.ChapterResponse, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
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
