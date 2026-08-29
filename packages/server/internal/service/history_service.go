package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"go.uber.org/zap"
	"gorm.io/datatypes"
)

// ErrInvalidVersionKind is returned when a caller requests a snapshot kind that
// only the server may create ("auto", "rollback", "import").
var ErrInvalidVersionKind = errors.New("invalid version kind")

// Retention tiers (business plan v3 A07 / E7). Automatic snapshots are
// bounded by both a count and an age; manual milestones are never pruned.
const (
	// RetentionFreeDays is the free-tier window.
	RetentionFreeDays = 3
	// RetentionPaidDays is the window once any paid (or trialing) plan is
	// active. Applies to grace/dormant too — downgrading must not retroactively
	// destroy history the author could still recover by renewing.
	RetentionPaidDays = 90
	// RetentionFreeKeep / RetentionPaidKeep cap snapshots per chapter.
	RetentionFreeKeep = 20
	RetentionPaidKeep = 200
)

// Retention describes how long one user's automatic snapshots are kept.
type Retention struct {
	KeepCount int   `json:"keep_count"`
	MaxDays   int   `json:"max_days"`
	Tier      string `json:"tier"` // free | paid | unlimited
}

// HistoryService owns the E1 chapter version history operations.
type HistoryService struct {
	chapterRepo repository.ChapterRepository
	versionRepo repository.ChapterVersionRepository
	cache       *cache.CacheManager
	cfg         config.VersionHistoryConfig
	subs        *SubscriptionService
	// localMode is the embedded desktop deployment (uid=0, no cloud billing).
	// Offline creation is a permanent entitlement, so local snapshots are
	// never aged out — storage is the user's own disk.
	localMode bool
}

// NewHistoryService creates a new HistoryService. subs may be nil, in which
// case every user resolves to the paid-tier retention (fail-open: never
// delete data because a lookup was unavailable).
func NewHistoryService(cr repository.ChapterRepository, vr repository.ChapterVersionRepository, cm *cache.CacheManager, cfg config.VersionHistoryConfig, subs *SubscriptionService, localMode bool) *HistoryService {
	return &HistoryService{
		chapterRepo: cr,
		versionRepo: vr,
		cache:       cm,
		cfg:         cfg,
		subs:        subs,
		localMode:   localMode,
	}
}

// ResolveRetention returns how long the user's automatic snapshots survive.
//
// Tier rules:
//   - local embedded mode → unlimited (offline creation is permanent)
//   - trialing / active / grace / dormant → paid window (90 days, 200 per chapter)
//   - no subscription row → free window (3 days, 20 per chapter)
//
// Grace and dormant keep the paid window on purpose: downgrading an account
// must not immediately destroy history it could still recover by renewing.
func (s *HistoryService) ResolveRetention(ctx context.Context, userID int64) (*Retention, error) {
	if s.localMode {
		return &Retention{KeepCount: RetentionPaidKeep, MaxDays: 0, Tier: "unlimited"}, nil
	}
	if s.subs == nil {
		return &Retention{KeepCount: RetentionPaidKeep, MaxDays: RetentionPaidDays, Tier: "paid"}, nil
	}
	view, err := s.subs.View(ctx, userID)
	if err != nil || view == nil {
		// Fail open: a billing outage must never cascade into data deletion.
		zap.L().Warn("version history: retention lookup failed, assuming paid tier",
			zap.Int64("user_id", userID), zap.Error(err))
		return &Retention{KeepCount: RetentionPaidKeep, MaxDays: RetentionPaidDays, Tier: "paid"}, nil
	}
	switch view.Status {
	case model.SubscriptionTrialing, model.SubscriptionActive,
		model.SubscriptionGrace, model.SubscriptionDormant:
		return &Retention{KeepCount: RetentionPaidKeep, MaxDays: RetentionPaidDays, Tier: "paid"}, nil
	default:
		return &Retention{KeepCount: RetentionFreeKeep, MaxDays: RetentionFreeDays, Tier: "free"}, nil
	}
}

// SweepExpiredVersions prunes automatic snapshots past their retention window
// for every user that has any. Intended for the daily cron.
//
// It never touches milestone / rollback / import versions. Returns the number
// of rows deleted and the number of users processed.
func (s *HistoryService) SweepExpiredVersions(ctx context.Context) (deleted int64, users int, err error) {
	if s.localMode {
		return 0, 0, nil
	}
	ids, err := s.versionRepo.ListUsersWithAuto(ctx)
	if err != nil {
		return 0, 0, err
	}
	now := time.Now()
	for _, uid := range ids {
		ret, rerr := s.ResolveRetention(ctx, uid)
		if rerr != nil {
			zap.L().Warn("version history: skip user in retention sweep",
				zap.Int64("user_id", uid), zap.Error(rerr))
			continue
		}
		if ret.MaxDays <= 0 {
			continue // unlimited tier
		}
		cutoff := now.Add(-time.Duration(ret.MaxDays) * 24 * time.Hour)
		n, derr := s.versionRepo.PruneAutoBefore(ctx, uid, cutoff)
		if derr != nil {
			zap.L().Warn("version history: prune failed for user",
				zap.Int64("user_id", uid), zap.Error(derr))
			continue
		}
		deleted += n
		users++
	}
	return deleted, users, nil
}

// ListVersions returns content-free summaries for a chapter, newest first.
func (s *HistoryService) ListVersions(ctx context.Context, userID, chapterID int64, limit, offset int) (*dto.VersionListResponse, error) {
	if !s.owned(ctx, userID, chapterID) {
		return nil, ErrNotFound
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	versions, err := s.versionRepo.ListByChapter(ctx, userID, chapterID, limit, offset)
	if err != nil {
		return nil, err
	}
	// Total is counted separately because ListByChapter is capped; the UI
	// needs the uncapped number to render pagination.
	total, err := s.versionRepo.CountByChapter(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	out := make([]dto.ChapterVersionSummary, 0, len(versions))
	for i := range versions {
		out = append(out, toVersionSummary(&versions[i]))
	}

	resp := &dto.VersionListResponse{Versions: out, Total: total, Limit: limit, Offset: offset}
	// Retention is advisory: if the lookup fails the panel simply omits the
	// hint rather than failing the whole list request.
	if ret, rerr := s.ResolveRetention(ctx, userID); rerr == nil && ret != nil {
		resp.Retention = &dto.RetentionInfo{
			KeepCount: ret.KeepCount,
			MaxDays:   ret.MaxDays,
			Tier:      ret.Tier,
		}
	}
	return resp, nil
}

// GetVersion returns a single snapshot with its full body.
func (s *HistoryService) GetVersion(ctx context.Context, userID, chapterID, versionID int64) (*dto.ChapterVersionDetail, error) {
	if !s.owned(ctx, userID, chapterID) {
		return nil, ErrNotFound
	}
	v, err := s.versionRepo.GetByID(ctx, userID, versionID)
	if err != nil {
		return nil, err
	}
	// A version belonging to another chapter must not be readable through this
	// chapter's endpoint even for the rightful owner.
	if v == nil || v.ChapterID != chapterID {
		return nil, ErrNotFound
	}
	return toVersionDetail(v), nil
}

// CreateSnapshot writes an explicit checkpoint of the chapter's current text.
// Only milestone and ai_rewrite kinds are accepted from clients; the automatic
// kinds are produced by the A03 write hook.
func (s *HistoryService) CreateSnapshot(ctx context.Context, userID, chapterID int64, req *dto.CreateVersionRequest) (*dto.ChapterVersionSummary, error) {
	kind := req.Kind
	if kind == "" {
		kind = model.VersionKindMilestone
	}
	if kind != model.VersionKindMilestone && kind != model.VersionKindAIMark {
		return nil, ErrInvalidVersionKind
	}

	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	hash := ""
	if chapter.Content != nil {
		hash = contentHash(*chapter.Content)
	}
	v := &model.ChapterVersion{
		UserID:      userID,
		ChapterID:   chapter.ID,
		NovelID:     chapter.NovelID,
		Title:       chapter.Title,
		Content:     chapter.Content,
		ContentJSON: chapter.ContentJSON,
		WordCount:   chapter.WordCount,
		Kind:        kind,
		Label:       req.Label,
		ContentHash: hash,
	}
	if err := s.versionRepo.Create(ctx, v); err != nil {
		return nil, err
	}
	summary := toVersionSummary(v)
	return &summary, nil
}

// RestoreVersion rolls a chapter back to a snapshot.
//
// The current text is checkpointed as a "rollback" version before being
// overwritten, which makes the rollback itself reversible — the author never
// loses the text they had on screen. Returns the checkpoint that was written.
func (s *HistoryService) RestoreVersion(ctx context.Context, userID, chapterID, versionID int64) (*dto.ChapterVersionSummary, error) {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		return nil, err
	}
	if chapter == nil {
		return nil, ErrNotFound
	}

	target, err := s.versionRepo.GetByID(ctx, userID, versionID)
	if err != nil {
		return nil, err
	}
	if target == nil || target.ChapterID != chapterID {
		return nil, ErrNotFound
	}

	// 1. Checkpoint what is being replaced.
	currentHash := ""
	if chapter.Content != nil {
		currentHash = contentHash(*chapter.Content)
	}
	checkpoint := &model.ChapterVersion{
		UserID:      userID,
		ChapterID:   chapter.ID,
		NovelID:     chapter.NovelID,
		Title:       chapter.Title,
		Content:     chapter.Content,
		ContentJSON: chapter.ContentJSON,
		WordCount:   chapter.WordCount,
		Kind:        model.VersionKindRollback,
		Label:       fmt.Sprintf("回滚至 #%d 前的状态", versionID),
		ContentHash: currentHash,
	}
	if err := s.versionRepo.Create(ctx, checkpoint); err != nil {
		return nil, err
	}

	// 2. Overwrite the chapter with the snapshot body.
	if target.Content != nil {
		chapter.Content = target.Content
	}
	if len(target.ContentJSON) > 0 {
		chapter.ContentJSON = datatypes.JSON(target.ContentJSON)
	}
	chapter.Title = target.Title
	chapter.WordCount = target.WordCount

	if err := s.chapterRepo.Update(ctx, userID, chapter); err != nil {
		zap.L().Error("version history: rollback write failed",
			zap.Int64("chapter_id", chapterID), zap.Int64("version_id", versionID), zap.Error(err))
		return nil, err
	}

	// 3. Same post-write bookkeeping as ChapterService.UpdateChapter.
	if s.cache != nil {
		_ = s.cache.Delete(ctx, fmt.Sprintf(cache.ChapterContent, userID, chapterID))
	}
	if err := s.chapterRepo.RefreshNovelWordCount(ctx, userID, chapter.NovelID); err != nil {
		zap.L().Warn("version history: word count refresh failed after rollback",
			zap.Int64("novel_id", chapter.NovelID), zap.Error(err))
	}

	summary := toVersionSummary(checkpoint)
	return &summary, nil
}

// owned reports whether the chapter exists within the user's scope.
func (s *HistoryService) owned(ctx context.Context, userID, chapterID int64) bool {
	chapter, err := s.chapterRepo.GetByID(ctx, userID, chapterID)
	return err == nil && chapter != nil
}

func toVersionSummary(v *model.ChapterVersion) dto.ChapterVersionSummary {
	return dto.ChapterVersionSummary{
		ID:          v.ID,
		ChapterID:   v.ChapterID,
		NovelID:     v.NovelID,
		Title:       v.Title,
		WordCount:   v.WordCount,
		Kind:        v.Kind,
		Label:       v.Label,
		ContentHash: v.ContentHash,
		CreatedAt:   v.CreatedAt,
	}
}

func toVersionDetail(v *model.ChapterVersion) *dto.ChapterVersionDetail {
	d := &dto.ChapterVersionDetail{ChapterVersionSummary: toVersionSummary(v)}
	if v.Content != nil {
		d.Content = *v.Content
	}
	if len(v.ContentJSON) > 0 {
		d.ContentJSON = json.RawMessage(v.ContentJSON)
	}
	return d
}
