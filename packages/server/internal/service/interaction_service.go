package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/datatypes"
)

// Interaction-domain errors (plan A28).
var (
	ErrInteractionInvalid  = errors.New("invalid interaction payload")
	ErrInteractionNotFound = errors.New("interaction not found")
)

// moodKeys is the closed set of one-click emotions (燃/刀/甜/谜).
var moodKeys = map[string]bool{
	model.MoodFire: true, model.MoodKnife: true, model.MoodSweet: true, model.MoodMystery: true,
}

// InteractionService owns reader interactions (plan A28): line comments,
// one-click moods, likes and author adoption.
type InteractionService struct {
	interactionRepo repository.InteractionRepository
	readRepo        repository.PublishedReadRepository
	userRepo        repository.UserRepository
	cs              contentsafety.Checker
	// notifier is an optional callback invoked after a reader-facing event
	// (e.g. adoption) so the realtime WS layer can push to the reader (D14).
	notifier AdoptNotifier
}

// AdoptNotifier is invoked with the target user and a kind/payload pair after
// a reader-facing event. The WS layer adapts it into a notification frame.
type AdoptNotifier func(userID int64, kind string, payload map[string]any)

// NewInteractionService creates a new InteractionService.
func NewInteractionService(
	ir repository.InteractionRepository,
	rr repository.PublishedReadRepository,
	ur repository.UserRepository,
	cs contentsafety.Checker,
) *InteractionService {
	return &InteractionService{interactionRepo: ir, readRepo: rr, userRepo: ur, cs: cs}
}

// WithNotifier injects the realtime notification callback (D14).
func (s *InteractionService) WithNotifier(n AdoptNotifier) *InteractionService {
	s.notifier = n
	return s
}

// List returns a chapter's visible interactions plus whether viewerUserID is
// the work's author (so the UI can reveal author actions).
func (s *InteractionService) List(ctx context.Context, pid int64, viewerUserID int64) (*dto.InteractionListResponse, error) {
	ch, err := s.readRepo.ChapterPublic(ctx, pid)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, ErrNotFound
	}
	owner, err := s.readRepo.WorkOwner(ctx, ch.WorkID)
	if err != nil {
		return nil, err
	}

	list, err := s.interactionRepo.ListByChapter(ctx, pid, "")
	if err != nil {
		return nil, err
	}

	liked := map[int64]bool{}
	if viewerUserID != 0 {
		if ids, err := s.interactionRepo.ListLikedIDs(ctx, viewerUserID, pid); err == nil {
			for _, id := range ids {
				liked[id] = true
			}
		}
	}

	out := make([]dto.InteractionDTO, 0, len(list))
	for i := range list {
		it := &list[i]
		d := s.toDTO(ctx, it)
		d.LikedByMe = liked[it.ID]
		out = append(out, d)
	}
	return &dto.InteractionListResponse{
		Interactions: out,
		IsAuthor:     viewerUserID != 0 && viewerUserID == owner,
	}, nil
}

// Create posts a comment or mood. Comments pass the content-safety checker
// (C12); moods are a closed set and need no inspection.
func (s *InteractionService) Create(ctx context.Context, userID int64, pid int64, req *dto.CreateInteractionRequest) (*dto.InteractionDTO, error) {
	ch, err := s.readRepo.ChapterPublic(ctx, pid)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, ErrNotFound
	}

	payload, err := validatePayload(req.Type, req.Payload)
	if err != nil {
		return nil, err
	}
	if req.Type == model.InteractionComment {
		text := payload["text"]
		if s.cs != nil {
			res, err := s.cs.CheckText(contentsafety.WithEndpoint(ctx, "/api/v1/read/chapters/interactions"), text)
			if err != nil {
				return nil, fmt.Errorf("content safety check error: %w", err)
			}
			if !res.Pass {
				return nil, contentsafety.ErrContentRejected
			}
		}
	}

	raw, _ := json.Marshal(payload)
	it := &model.Interaction{
		UserID:     userID,
		ChapterID:  pid,
		Type:       req.Type,
		BlockIndex: req.BlockIndex,
		Anchor:     req.Anchor,
		Payload:    datatypes.JSON(raw),
		Status:     model.InteractionStatusPending,
	}
	if err := s.interactionRepo.Create(ctx, it); err != nil {
		return nil, err
	}
	out := s.toDTO(ctx, it)
	return &out, nil
}

// ToggleLike flips the viewer's like on an interaction, returning the new
// like count and state.
func (s *InteractionService) ToggleLike(ctx context.Context, userID, interactionID int64) (*dto.LikeResponse, error) {
	it, err := s.interactionRepo.GetByID(ctx, interactionID)
	if err != nil {
		return nil, err
	}
	if it == nil || it.Status == model.InteractionStatusHidden {
		return nil, ErrInteractionNotFound
	}

	existing, err := s.interactionRepo.GetVote(ctx, userID, interactionID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err := s.interactionRepo.DeleteVote(ctx, userID, interactionID); err != nil {
			return nil, err
		}
		if err := s.interactionRepo.DecLikeCount(ctx, interactionID); err != nil {
			return nil, err
		}
		likes := it.LikeCount - 1
		if likes < 0 {
			likes = 0
		}
		return &dto.LikeResponse{InteractionID: interactionID, LikeCount: likes, Liked: false}, nil
	}

	if err := s.interactionRepo.UpsertVote(ctx, &model.InteractionVote{UserID: userID, InteractionID: interactionID, Value: 1}); err != nil {
		return nil, err
	}
	if err := s.interactionRepo.IncLikeCount(ctx, interactionID); err != nil {
		return nil, err
	}
	return &dto.LikeResponse{InteractionID: interactionID, LikeCount: it.LikeCount + 1, Liked: true}, nil
}

// Adopt marks an interaction as adopted. Only the work's author may adopt;
// other callers get ErrNotFound (no existence leak).
func (s *InteractionService) Adopt(ctx context.Context, authorUserID, interactionID int64) error {
	it, err := s.interactionRepo.GetByID(ctx, interactionID)
	if err != nil {
		return err
	}
	if it == nil {
		return ErrInteractionNotFound
	}
	owner, err := s.ownerOfChapter(ctx, it.ChapterID)
	if err != nil {
		return err
	}
	if owner != authorUserID {
		return ErrNotFound
	}
	if err := s.interactionRepo.UpdateStatus(ctx, interactionID, model.InteractionStatusAdopted); err != nil {
		return err
	}
	// D14：采纳后实时通知读者（作者采纳了 TA 的建议）。
	if s.notifier != nil {
		s.notifier(it.UserID, "interaction_adopted", map[string]any{"interaction_id": interactionID})
	}
	return nil
}

// Hide soft-deletes an interaction. The commenter or the work's owner may hide.
func (s *InteractionService) Hide(ctx context.Context, userID, interactionID int64) error {
	it, err := s.interactionRepo.GetByID(ctx, interactionID)
	if err != nil {
		return err
	}
	if it == nil {
		return ErrInteractionNotFound
	}
	if it.UserID != userID {
		owner, err := s.ownerOfChapter(ctx, it.ChapterID)
		if err != nil {
			return err
		}
		if owner != userID {
			return ErrNotFound
		}
	}
	return s.interactionRepo.UpdateStatus(ctx, interactionID, model.InteractionStatusHidden)
}

// ownerOfChapter resolves the owner user_id of the work a published chapter
// belongs to, or ErrNotFound if the chapter isn't public.
func (s *InteractionService) ownerOfChapter(ctx context.Context, pid int64) (int64, error) {
	ch, err := s.readRepo.ChapterPublic(ctx, pid)
	if err != nil {
		return 0, err
	}
	if ch == nil {
		return 0, ErrNotFound
	}
	return s.readRepo.WorkOwner(ctx, ch.WorkID)
}

func (s *InteractionService) toDTO(ctx context.Context, it *model.Interaction) dto.InteractionDTO {
	d := dto.InteractionDTO{
		ID:         it.ID,
		ChapterID:  it.ChapterID,
		UserID:     it.UserID,
		Type:       it.Type,
		BlockIndex: it.BlockIndex,
		Anchor:     it.Anchor,
		Status:     it.Status,
		LikeCount:  it.LikeCount,
		IsAuthor:   false, // set by caller where relevant
		CreatedAt:  it.CreatedAt,
	}
	if len(it.Payload) > 0 {
		d.Payload = json.RawMessage(it.Payload)
	}
	if it.Type == model.InteractionComment {
		if u, err := s.userRepo.GetByID(ctx, it.UserID); err == nil && u != nil {
			d.Nickname = u.Nickname
		}
	}
	return d
}

// validatePayload checks and normalises the type-specific payload.
func validatePayload(typ string, raw json.RawMessage) (map[string]string, error) {
	if len(raw) == 0 {
		return nil, ErrInteractionInvalid
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, ErrInteractionInvalid
	}
	switch typ {
	case model.InteractionComment:
		if strings.TrimSpace(m["text"]) == "" {
			return nil, ErrInteractionInvalid
		}
	case model.InteractionMood:
		if !moodKeys[m["mood"]] {
			return nil, ErrInteractionInvalid
		}
	default:
		return nil, ErrInteractionInvalid
	}
	return m, nil
}
