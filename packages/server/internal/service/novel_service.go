package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"go.uber.org/zap"
)

// ErrNotFound is returned when a requested resource does not exist.
var ErrNotFound = errors.New("resource not found")

// NovelService handles novel business logic.
type NovelService struct {
	novelRepo   repository.NovelRepository
	chapterRepo repository.ChapterRepository
	cache       *cache.CacheManager
	docRepo     repository.NovelDocRepository
}

// NewNovelService creates a new NovelService. The optional docRepo enables
// transactional cascade deletion of novel_outline / novel_memory rows; it is
// variadic to keep this constructor backward compatible until wiring is updated.
func NewNovelService(nr repository.NovelRepository, cr repository.ChapterRepository, cm *cache.CacheManager, docRepos ...repository.NovelDocRepository) *NovelService {
	s := &NovelService{novelRepo: nr, chapterRepo: cr, cache: cm}
	if len(docRepos) > 0 {
		s.docRepo = docRepos[0]
	}
	return s
}

// CreateNovel creates a new novel and returns the response DTO.
func (s *NovelService) CreateNovel(ctx context.Context, req *dto.CreateNovelRequest) (*dto.NovelResponse, error) {
	novel := &model.Novel{
		Title: req.Title,
	}
	if req.Genre != "" {
		novel.Genre = &req.Genre
	}
	if req.Description != "" {
		novel.Description = &req.Description
	}
	if req.CoverImage != "" {
		novel.CoverImage = &req.CoverImage
	}

	if err := s.novelRepo.Create(ctx, novel); err != nil {
		return nil, err
	}
	return toNovelResponse(novel), nil
}

// GetNovel retrieves a novel by ID (with cache).
func (s *NovelService) GetNovel(ctx context.Context, id int64) (*dto.NovelResponse, error) {
	key := fmt.Sprintf(cache.NovelKey, id)
	var resp dto.NovelResponse

	err := s.cache.GetWithNullCache(ctx, key, &resp, cache.NovelTTL, func() (interface{}, error) {
		novel, err := s.novelRepo.GetByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if novel == nil {
			return nil, nil // triggers null cache
		}
		return toNovelResponse(novel), nil
	})

	if errors.Is(err, cache.ErrNullCached) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// ListNovels lists novels with pagination.
func (s *NovelService) ListNovels(ctx context.Context, page, pageSize int) (*dto.ListNovelsResponse, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	novels, total, err := s.novelRepo.List(ctx, offset, pageSize)
	if err != nil {
		return nil, err
	}

	responses := make([]dto.NovelResponse, 0, len(novels))
	for i := range novels {
		responses = append(responses, *toNovelResponse(&novels[i]))
	}

	return &dto.ListNovelsResponse{Novels: responses, Total: total}, nil
}

// UpdateNovel updates an existing novel.
func (s *NovelService) UpdateNovel(ctx context.Context, id int64, req *dto.UpdateNovelRequest) (*dto.NovelResponse, error) {
	novel, err := s.novelRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if novel == nil {
		return nil, ErrNotFound
	}

	if req.Title != nil {
		novel.Title = *req.Title
	}
	if req.Genre != nil {
		novel.Genre = req.Genre
	}
	if req.Description != nil {
		novel.Description = req.Description
	}
	if req.CoverImage != nil {
		novel.CoverImage = req.CoverImage
	}
	if req.Status != nil {
		novel.Status = *req.Status
	}

	if err := s.novelRepo.Update(ctx, novel); err != nil {
		return nil, err
	}
	// Invalidate cache after update
	_ = s.cache.Delete(ctx, fmt.Sprintf(cache.NovelKey, id))
	return toNovelResponse(novel), nil
}

// DeleteNovel deletes a novel and everything it owns in a single transaction:
// chapters are soft-deleted, novel_outline / novel_memory rows are hard-deleted,
// and the novel itself keeps its existing soft-delete semantics. Any failure
// rolls the whole cascade back.
func (s *NovelService) DeleteNovel(ctx context.Context, id int64) error {
	novel, err := s.novelRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	if novel == nil {
		return ErrNotFound
	}

	if s.docRepo != nil {
		err = s.docRepo.CascadeDeleteNovel(ctx, id)
	} else {
		// Fallback without the doc repository: legacy non-transactional path.
		if delErr := s.chapterRepo.DeleteByNovelID(ctx, id); delErr != nil {
			return delErr
		}
		err = s.novelRepo.Delete(ctx, id)
	}
	if err != nil {
		zap.L().Error("failed to delete novel cascade", zap.Int64("novel_id", id), zap.Error(err))
		return err
	}
	_ = s.cache.Delete(ctx, fmt.Sprintf(cache.NovelKey, id))
	return nil
}

func toNovelResponse(n *model.Novel) *dto.NovelResponse {
	resp := &dto.NovelResponse{
		ID:        n.ID,
		Title:     n.Title,
		WordCount: n.WordCount,
		Status:    n.Status,
		CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt,
	}
	if n.Genre != nil {
		resp.Genre = *n.Genre
	}
	if n.Description != nil {
		resp.Description = *n.Description
	}
	if n.CoverImage != nil {
		resp.CoverImage = *n.CoverImage
	}
	return resp
}
