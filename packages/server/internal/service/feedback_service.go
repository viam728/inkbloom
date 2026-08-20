package service

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// Feedback limits and sentinel errors (task #51, M6).
const feedbackContentLimit = 2000
const feedbackContactLimit = 128

var (
	// ErrFeedbackInvalidCategory is returned for unknown categories (HTTP 400).
	ErrFeedbackInvalidCategory = errors.New("category must be one of bug/feature/other")
	// ErrFeedbackContentEmpty is returned for blank content (HTTP 400).
	ErrFeedbackContentEmpty = errors.New("content must not be empty")
	// ErrFeedbackContentTooLong is returned when content exceeds 2000 chars (HTTP 400).
	ErrFeedbackContentTooLong = errors.New("content exceeds 2000 characters")
	// ErrFeedbackContactTooLong is returned when contact exceeds 128 chars (HTTP 400).
	ErrFeedbackContactTooLong = errors.New("contact exceeds 128 characters")
	// ErrFeedbackNotFound is returned for missing feedback rows (HTTP 404).
	ErrFeedbackNotFound = errors.New("feedback not found")
	// ErrFeedbackInvalidStatus is returned for unknown statuses (HTTP 400).
	ErrFeedbackInvalidStatus = errors.New("status must be one of open/resolved")
)

// FeedbackService implements user feedback submission and the back-office
// feedback list/status endpoints (task #51, M6).
type FeedbackService struct {
	repo   repository.FeedbackRepository
	logger *zap.Logger
}

// NewFeedbackService creates a FeedbackService.
func NewFeedbackService(repo repository.FeedbackRepository, logger *zap.Logger) *FeedbackService {
	return &FeedbackService{repo: repo, logger: logger}
}

// Create validates and stores a feedback entry, returning the new id.
func (s *FeedbackService) Create(ctx context.Context, userID int64, req dto.CreateFeedbackRequest) (int64, error) {
	switch req.Category {
	case model.FeedbackCategoryBug, model.FeedbackCategoryFeature, model.FeedbackCategoryOther:
	default:
		return 0, ErrFeedbackInvalidCategory
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return 0, ErrFeedbackContentEmpty
	}
	if utf8.RuneCountInString(content) > feedbackContentLimit {
		return 0, ErrFeedbackContentTooLong
	}
	contact := strings.TrimSpace(req.Contact)
	if utf8.RuneCountInString(contact) > feedbackContactLimit {
		return 0, ErrFeedbackContactTooLong
	}

	fb := &model.Feedback{
		UserID:   userID,
		Category: req.Category,
		Content:  content,
		Status:   model.FeedbackStatusOpen,
	}
	if contact != "" {
		fb.Contact = &contact
	}
	if err := s.repo.Create(ctx, fb); err != nil {
		return 0, err
	}
	s.logger.Info("feedback submitted",
		zap.Int64("id", fb.ID),
		zap.Int64("user_id", userID),
		zap.String("category", fb.Category))
	return fb.ID, nil
}

// List returns the back-office feedback list (nickname joined, newest first).
func (s *FeedbackService) List(ctx context.Context, status string, limit int) ([]dto.FeedbackItem, error) {
	rows, err := s.repo.List(ctx, status, limit)
	if err != nil {
		return nil, err
	}
	items := make([]dto.FeedbackItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, dto.FeedbackItem{
			ID:        r.ID,
			UserID:    r.UserID,
			Nickname:  r.Nickname,
			Category:  r.Category,
			Content:   r.Content,
			Contact:   r.Contact,
			Status:    r.Status,
			CreatedAt: r.CreatedAt,
		})
	}
	return items, nil
}

// SetStatus flips a feedback entry between open/resolved.
func (s *FeedbackService) SetStatus(ctx context.Context, operatorID, id int64, status string) error {
	switch status {
	case model.FeedbackStatusOpen, model.FeedbackStatusResolved:
	default:
		return ErrFeedbackInvalidStatus
	}
	if err := s.repo.UpdateStatus(ctx, id, status); err != nil {
		return err
	}
	s.logger.Info("feedback status changed",
		zap.Int64("operator_id", operatorID),
		zap.Int64("feedback_id", id),
		zap.String("status", status))
	return nil
}
