package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"github.com/inkbloom/server/internal/model"
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
	novelRepo   repository.NovelRepository
	docRepo     repository.NovelDocRepository
	chapterRepo repository.ChapterRepository
}

// NewNovelDocService creates a new NovelDocService.
func NewNovelDocService(
	nr repository.NovelRepository,
	dr repository.NovelDocRepository,
	cr repository.ChapterRepository,
) *NovelDocService {
	return &NovelDocService{novelRepo: nr, docRepo: dr, chapterRepo: cr}
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
