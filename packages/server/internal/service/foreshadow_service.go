package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// ForeshadowService owns the E2 foreshadow tracking operations
// (business plan v3, construction plan A12).
type ForeshadowService struct {
	repo         repository.ForeshadowRepository
	chapterRepo  repository.ChapterRepository
	novelRepo    repository.NovelRepository
	aiServiceURL string
	httpClient   *http.Client
}

// NewForeshadowService creates a new ForeshadowService.
func NewForeshadowService(fr repository.ForeshadowRepository, cr repository.ChapterRepository, nr repository.NovelRepository, aiServiceURL string) *ForeshadowService {
	return &ForeshadowService{
		repo:         fr,
		chapterRepo:  cr,
		novelRepo:    nr,
		aiServiceURL: strings.TrimRight(aiServiceURL, "/"),
		httpClient:   &http.Client{Timeout: 3 * time.Minute},
	}
}

// ownedNovel verifies the novel belongs to the user.
//
// Without this, listing another user's foreshadows returns 200 with an empty
// array: the row-level scope already hides the data, but the response still
// confirms the endpoint accepted the request. Returning ErrNotFound keeps the
// answer identical to a novel that does not exist at all.
func (s *ForeshadowService) ownedNovel(ctx context.Context, userID, novelID int64) error {
	if s.novelRepo == nil {
		return nil
	}
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		return err
	}
	if novel == nil {
		return ErrNotFound
	}
	return nil
}

// List returns every thread of a novel with chapter titles resolved.
func (s *ForeshadowService) List(ctx context.Context, userID, novelID int64) ([]dto.ForeshadowResponse, error) {
	if err := s.ownedNovel(ctx, userID, novelID); err != nil {
		return nil, err
	}
	list, err := s.repo.ListByNovel(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	return s.toResponses(ctx, userID, list), nil
}

// ListPending returns unresolved threads (planted + reminded) ordered by how
// urgently they should be paid off.
func (s *ForeshadowService) ListPending(ctx context.Context, userID, novelID int64) ([]dto.ForeshadowResponse, error) {
	if err := s.ownedNovel(ctx, userID, novelID); err != nil {
		return nil, err
	}
	list, err := s.repo.ListByStatus(ctx, userID, novelID,
		[]string{model.ForeshadowPlanted, model.ForeshadowReminded})
	if err != nil {
		return nil, err
	}
	return s.toResponses(ctx, userID, list), nil
}

// Create registers a thread manually.
func (s *ForeshadowService) Create(ctx context.Context, userID, novelID int64, req *dto.CreateForeshadowRequest) (*dto.ForeshadowResponse, error) {
	if err := s.ownedNovel(ctx, userID, novelID); err != nil {
		return nil, err
	}
	source := req.Source
	if source == "" {
		source = model.ForeshadowSourceManual
	}
	f := &model.Foreshadow{
		UserID:         userID,
		NovelID:        novelID,
		Description:    req.Description,
		PlantChapterID: req.PlantChapterID,
		PlantAnchor:    req.PlantAnchor,
		ExpectChapter:  req.ExpectChapter,
		Status:         model.ForeshadowPlanted,
		Source:         source,
	}
	if err := s.repo.Create(ctx, f); err != nil {
		return nil, err
	}
	out := s.toResponse(ctx, userID, f)
	return &out, nil
}

// UpdateStatus transitions a thread's lifecycle state.
//
// Resolving requires a chapter id so the tracker can jump to the payoff
// scene; the other transitions ignore it.
func (s *ForeshadowService) UpdateStatus(ctx context.Context, userID, id int64, req *dto.UpdateForeshadowStatusRequest) (*dto.ForeshadowResponse, error) {
	f, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrNotFound
	}
	f.Status = req.Status
	if req.Status == model.ForeshadowResolved {
		if req.ResolveChapterID == nil {
			f.ResolveChapterID = nil
		} else {
			f.ResolveChapterID = req.ResolveChapterID
		}
	}
	if err := s.repo.Update(ctx, userID, f); err != nil {
		return nil, err
	}
	out := s.toResponse(ctx, userID, f)
	return &out, nil
}

// Delete removes a thread.
func (s *ForeshadowService) Delete(ctx context.Context, userID, id int64) error {
	f, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return err
	}
	if f == nil {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, userID, id)
}

// hintUpcomingWindow is how many chapters ahead still counts as "due soon".
const hintUpcomingWindow = 2

// Hints returns proactive nudges for the writing surface (plan A15), ordered
// most-urgent first so the UI can simply render hints[0].
//
// Only threads still in `planted` produce hints. A thread that has moved to
// `reminded` was already surfaced once — nudging about it again is exactly the
// nagging that makes people switch the whole feature off.
func (s *ForeshadowService) Hints(ctx context.Context, userID, novelID, chapterID int64) (*dto.HintsResponse, error) {
	if err := s.ownedNovel(ctx, userID, novelID); err != nil {
		return nil, err
	}
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}
	current := chapter.Position

	open, err := s.repo.ListByStatus(ctx, userID, novelID, []string{model.ForeshadowPlanted})
	if err != nil {
		return nil, err
	}

	var overdue, upcoming []dto.ForeshadowHint
	for i := range open {
		f := &open[i]
		if f.ExpectChapter == nil {
			continue // no expectation → nothing to be late for
		}
		expect := *f.ExpectChapter
		switch {
		case current > expect:
			overdue = append(overdue, dto.ForeshadowHint{
				Type:            "overdue",
				Severity:        "warn",
				ForeshadowID:    f.ID,
				Message:         fmt.Sprintf("第 %d 章该回收「%s」了，已超期 %d 章", expect, f.Description, current-expect),
				ChaptersOverdue: current - expect,
			})
		case expect-current <= hintUpcomingWindow:
			// A zero-distance thread is due in the chapter being written, so
			// "还有 0 章" would read as nonsense; say "本章" instead.
			untilDue := expect - current
			msg := fmt.Sprintf("还有 %d 章就到第 %d 章了，记得回收「%s」", untilDue, expect, f.Description)
			if untilDue == 0 {
				msg = fmt.Sprintf("本章就该回收「%s」了", f.Description)
			}
			upcoming = append(upcoming, dto.ForeshadowHint{
				Type:             "upcoming",
				Severity:         "info",
				ForeshadowID:     f.ID,
				Message:          msg,
				ChaptersUntilDue: untilDue,
			})
		}
	}

	// Overdue always outranks upcoming; inside each bucket the nearest
	// deadline comes first.
	sort.Slice(overdue, func(i, j int) bool {
		return overdue[i].ChaptersOverdue > overdue[j].ChaptersOverdue
	})
	sort.Slice(upcoming, func(i, j int) bool {
		return upcoming[i].ChaptersUntilDue < upcoming[j].ChaptersUntilDue
	})

	hints := append(overdue, upcoming...)
	if hints == nil {
		hints = []dto.ForeshadowHint{}
	}
	return &dto.HintsResponse{Hints: hints}, nil
}

// DetectPlants asks the AI service for candidate setups in one chapter.
//
// Candidates are returned to the author for confirmation and are NEVER
// persisted here — a false-positive thread silently written to the ledger
// would be worse than a missed one.
//
// Degraded (not failed) when the AI service is unreachable: losing detection
// must not take down the tracker, which is still useful manually.
func (s *ForeshadowService) DetectPlants(ctx context.Context, userID, novelID, chapterID int64) (*dto.DetectPlantsResponse, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	payload := map[string]interface{}{
		"novel_id":   novelID,
		"chapter_id": chapterID,
		"text":       derefString(chapter.Content),
	}
	var out struct {
		Candidates []dto.ForeshadowCandidate `json:"candidates"`
		// Degraded is set by ai-service when it caught an error itself
		// (e.g. upstream LLM auth failure) and still answered 200.
		Degraded bool `json:"degraded"`
	}
	if err := s.postAI(ctx, "/api/knowledge/foreshadows/detect", payload, &out); err != nil {
		zap.L().Warn("foreshadow detection degraded",
			zap.Int64("chapter_id", chapterID), zap.Error(err))
		return &dto.DetectPlantsResponse{Candidates: []dto.ForeshadowCandidate{}, Degraded: true}, nil
	}
	if out.Candidates == nil {
		out.Candidates = []dto.ForeshadowCandidate{}
	}
	return &dto.DetectPlantsResponse{Candidates: out.Candidates, Degraded: out.Degraded}, nil
}

// ScanChapter asks the AI service which open threads this chapter pays off,
// then marks exactly those as resolved.
//
// This is the only place status changes without direct author intent, and it
// is deliberately narrow: it can only move planted/reminded → resolved (with
// the payoff chapter recorded). Planting always requires confirmation —
// see DetectPlants.
func (s *ForeshadowService) ScanChapter(ctx context.Context, userID, novelID, chapterID int64) (*dto.ScanChapterResponse, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	open, err := s.repo.ListByStatus(ctx, userID, novelID,
		[]string{model.ForeshadowPlanted, model.ForeshadowReminded})
	if err != nil {
		return nil, err
	}
	if len(open) == 0 {
		return &dto.ScanChapterResponse{Resolved: []dto.ForeshadowResponse{}, Scanned: 0}, nil
	}

	threads := make([]map[string]interface{}, 0, len(open))
	byID := make(map[int64]*model.Foreshadow, len(open))
	for i := range open {
		threads = append(threads, map[string]interface{}{
			"id":           open[i].ID,
			"description":  open[i].Description,
			"plant_anchor": open[i].PlantAnchor,
		})
		byID[open[i].ID] = &open[i]
	}

	payload := map[string]interface{}{
		"novel_id":   novelID,
		"chapter_id": chapterID,
		"text":       derefString(chapter.Content),
		"threads":    threads,
	}
	var out struct {
		Resolved []struct {
			ID         int64   `json:"id"`
			Anchor     string  `json:"anchor"`
			Confidence float64 `json:"confidence"`
		} `json:"resolved"`
		// Degraded is set by ai-service when it caught an error itself.
		Degraded bool `json:"degraded"`
	}
	if err := s.postAI(ctx, "/api/knowledge/foreshadows/resolve", payload, &out); err != nil {
		zap.L().Warn("foreshadow resolve scan degraded",
			zap.Int64("chapter_id", chapterID), zap.Error(err))
		return &dto.ScanChapterResponse{Resolved: []dto.ForeshadowResponse{}, Scanned: len(open), Degraded: true}, nil
	}

	resolved := make([]dto.ForeshadowResponse, 0, len(out.Resolved))
	for _, hit := range out.Resolved {
		f, ok := byID[hit.ID]
		if !ok {
			continue // AI echoed an unknown id: ignore rather than trust it
		}
		f.Status = model.ForeshadowResolved
		cid := chapterID
		f.ResolveChapterID = &cid
		if err := s.repo.Update(ctx, userID, f); err != nil {
			zap.L().Warn("foreshadow: failed to mark resolved",
				zap.Int64("foreshadow_id", f.ID), zap.Error(err))
			continue
		}
		resolved = append(resolved, s.toResponse(ctx, userID, f))
	}
	return &dto.ScanChapterResponse{Resolved: resolved, Scanned: len(open), Degraded: out.Degraded}, nil
}

// postAI posts payload to an ai-service path and decodes the JSON body.
func (s *ForeshadowService) postAI(ctx context.Context, path string, payload interface{}, out interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.aiServiceURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create upstream request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(raw))
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode AI response: %w", err)
	}
	return nil
}

// toResponse converts one thread, resolving chapter titles for the UI.
func (s *ForeshadowService) toResponse(ctx context.Context, userID int64, f *model.Foreshadow) dto.ForeshadowResponse {
	r := dto.ForeshadowResponse{
		ID:               f.ID,
		NovelID:          f.NovelID,
		Description:      f.Description,
		PlantChapterID:   f.PlantChapterID,
		PlantAnchor:      f.PlantAnchor,
		ExpectChapter:    f.ExpectChapter,
		Status:           f.Status,
		ResolveChapterID: f.ResolveChapterID,
		Source:           f.Source,
		CreatedAt:        f.CreatedAt,
		UpdatedAt:        f.UpdatedAt,
	}
	if f.PlantChapterID != nil {
		if ch, err := s.chapterRepo.GetByID(ctx, userID, *f.PlantChapterID); err == nil && ch != nil {
			r.PlantChapterTitle = ch.Title
		}
	}
	if f.ResolveChapterID != nil {
		if ch, err := s.chapterRepo.GetByID(ctx, userID, *f.ResolveChapterID); err == nil && ch != nil {
			r.ResolveChapterTitle = ch.Title
		}
	}
	return r
}

func (s *ForeshadowService) toResponses(ctx context.Context, userID int64, list []model.Foreshadow) []dto.ForeshadowResponse {
	out := make([]dto.ForeshadowResponse, 0, len(list))
	for i := range list {
		out = append(out, s.toResponse(ctx, userID, &list[i]))
	}
	return out
}

// derefString safely dereferences an optional string field.
func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
