package service

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// MediaService handles self-media content & topic business logic.
type MediaService struct {
	mediaRepo repository.MediaRepository
}

// NewMediaService creates a new MediaService.
func NewMediaService(repo repository.MediaRepository) *MediaService {
	return &MediaService{mediaRepo: repo}
}

// ── Contents ────────────────────────────────────────────────────────────

// ListContents returns all live contents ordered by position ASC.
func (s *MediaService) ListContents(ctx context.Context) ([]dto.MediaContentResponse, error) {
	contents, err := s.mediaRepo.ListContents(ctx)
	if err != nil {
		zap.L().Error("failed to list media contents", zap.Error(err))
		return nil, err
	}
	responses := make([]dto.MediaContentResponse, 0, len(contents))
	for i := range contents {
		responses = append(responses, *toMediaContentResponse(&contents[i]))
	}
	return responses, nil
}

// CreateContent creates a content at the tail position and returns it.
func (s *MediaService) CreateContent(ctx context.Context, req *dto.CreateMediaContentRequest) (*dto.MediaContentResponse, error) {
	tagsJSON, err := marshalTags(req.Tags)
	if err != nil {
		return nil, err
	}
	content := &model.MediaContent{
		Title:    req.Title,
		Platform: req.Platform,
		Content:  req.Content,
		Tags:     tagsJSON,
	}
	if err := s.mediaRepo.CreateContent(ctx, content); err != nil {
		zap.L().Error("failed to create media content", zap.String("title", req.Title), zap.Error(err))
		return nil, err
	}
	return toMediaContentResponse(content), nil
}

// UpdateContent applies a partial update and returns the refreshed entry.
func (s *MediaService) UpdateContent(ctx context.Context, id int64, req *dto.UpdateMediaContentRequest) (*dto.MediaContentResponse, error) {
	content, err := s.mediaRepo.GetContentByID(ctx, id)
	if err != nil {
		zap.L().Error("failed to fetch media content", zap.Int64("id", id), zap.Error(err))
		return nil, err
	}
	if content == nil {
		return nil, ErrNotFound
	}

	if req.Title != nil {
		content.Title = *req.Title
	}
	if req.Platform != nil {
		content.Platform = *req.Platform
	}
	if req.Content != nil {
		content.Content = *req.Content
	}
	if req.Tags != nil {
		tagsJSON, err := marshalTags(*req.Tags)
		if err != nil {
			return nil, err
		}
		content.Tags = tagsJSON
	}

	if err := s.mediaRepo.UpdateContent(ctx, content); err != nil {
		zap.L().Error("failed to update media content", zap.Int64("id", id), zap.Error(err))
		return nil, err
	}
	return toMediaContentResponse(content), nil
}

// DeleteContent soft-deletes a content by id.
func (s *MediaService) DeleteContent(ctx context.Context, id int64) error {
	content, err := s.mediaRepo.GetContentByID(ctx, id)
	if err != nil {
		zap.L().Error("failed to fetch media content", zap.Int64("id", id), zap.Error(err))
		return err
	}
	if content == nil {
		return ErrNotFound
	}
	if err := s.mediaRepo.DeleteContent(ctx, id); err != nil {
		zap.L().Error("failed to delete media content", zap.Int64("id", id), zap.Error(err))
		return err
	}
	return nil
}

// ReorderContents rewrites positions to 0..n-1 following orderedIDs.
// Idempotent: the last complete ordered list wins.
func (s *MediaService) ReorderContents(ctx context.Context, orderedIDs []int64) error {
	// Deduplicate ids, keeping first-occurrence order.
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

	if err := s.mediaRepo.ReorderContents(ctx, ids); err != nil {
		zap.L().Error("failed to reorder media contents", zap.Int("count", len(ids)), zap.Error(err))
		return err
	}
	return nil
}

// ── Topics ──────────────────────────────────────────────────────────────

// ListTopics returns all topics ordered by position ASC.
func (s *MediaService) ListTopics(ctx context.Context) ([]dto.TopicItem, error) {
	topics, err := s.mediaRepo.ListTopics(ctx)
	if err != nil {
		zap.L().Error("failed to list media topics", zap.Error(err))
		return nil, err
	}
	items := make([]dto.TopicItem, 0, len(topics))
	for i := range topics {
		items = append(items, dto.TopicItem{
			ID:        topics[i].ID,
			Title:     topics[i].Title,
			Note:      topics[i].Note,
			Status:    topics[i].Status,
			CreatedAt: topics[i].CreatedAt,
		})
	}
	return items, nil
}

// SaveTopics replaces the whole topic set atomically. Ids missing from the
// payload are server-generated; array order is persisted as position.
func (s *MediaService) SaveTopics(ctx context.Context, req *dto.SaveTopicsRequest) ([]dto.TopicItem, error) {
	topics := make([]model.MediaTopic, 0, len(req.Topics))
	now := time.Now()
	seenIDs := make(map[string]struct{}, len(req.Topics))
	for _, t := range req.Topics {
		id := t.ID
		if id == "" {
			id = "tp_" + uuid.NewString()
		} else {
			if _, dup := seenIDs[id]; dup {
				// Duplicate client ids would violate the PK; regenerate.
				id = "tp_" + uuid.NewString()
			}
		}
		seenIDs[id] = struct{}{}

		status := t.Status
		if status == "" {
			status = "idea"
		}
		createdAt := t.CreatedAt
		if createdAt.IsZero() {
			createdAt = now
		}
		topics = append(topics, model.MediaTopic{
			ID:        id,
			Title:     t.Title,
			Note:      t.Note,
			Status:    status,
			CreatedAt: createdAt,
		})
	}

	if err := s.mediaRepo.ReplaceTopics(ctx, topics); err != nil {
		zap.L().Error("failed to replace media topics", zap.Int("count", len(topics)), zap.Error(err))
		return nil, err
	}

	items := make([]dto.TopicItem, 0, len(topics))
	for i := range topics {
		items = append(items, dto.TopicItem{
			ID:        topics[i].ID,
			Title:     topics[i].Title,
			Note:      topics[i].Note,
			Status:    topics[i].Status,
			CreatedAt: topics[i].CreatedAt,
		})
	}
	return items, nil
}

// ── helpers ─────────────────────────────────────────────────────────────

// marshalTags serializes a string slice into a JSONB array ('[]' when empty).
func marshalTags(tags []string) ([]byte, error) {
	if tags == nil {
		tags = []string{}
	}
	b, err := json.Marshal(tags)
	if err != nil {
		zap.L().Error("failed to marshal media tags", zap.Error(err))
		return nil, err
	}
	return b, nil
}

// toMediaContentResponse converts a model into the frontend-facing DTO.
func toMediaContentResponse(c *model.MediaContent) *dto.MediaContentResponse {
	tags := make([]string, 0)
	if len(c.Tags) > 0 {
		if err := json.Unmarshal(c.Tags, &tags); err != nil {
			zap.L().Warn("failed to unmarshal media tags", zap.Int64("id", c.ID), zap.Error(err))
			tags = make([]string, 0)
		}
		if tags == nil {
			tags = make([]string, 0)
		}
	}
	return &dto.MediaContentResponse{
		ID:        c.ID,
		Title:     c.Title,
		Platform:  c.Platform,
		Content:   c.Content,
		Tags:      tags,
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
	}
}
