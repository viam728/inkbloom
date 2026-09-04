package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Restore modes (Agent safety work Q3).
const (
	// RestoreModeConservative updates what still exists and touches nothing
	// else. It is the default: an unexpected mode string degrades to it
	// rather than to destructive behaviour.
	RestoreModeConservative = "conservative"
	// RestoreModeFull additionally recreates missing chapters (keeping their
	// original ids) and deletes chapters written after the snapshot.
	RestoreModeFull = "full"
)

// checkpointLabel names the automatic snapshot taken right before a restore,
// which makes the restore itself reversible.
const checkpointLabel = "还原前自动快照"

// emptyJSONArray mirrors the canonical empty payload of the outline/memory
// documents; a restore of an empty snapshot must still be a valid wholesale
// replacement.
var emptyJSONArray = json.RawMessage("[]")

// NovelVersionService owns the Q3 whole-novel milestone snapshots: it bundles
// every chapter plus the outline and memory into one immutable row and can
// put the whole book back to that moment in a single call.
//
// The bundle is the point. Chapter-level history (E1) cannot answer "what did
// the book look like before the Agent rewrote it end to end" — the outline and
// the chapter set move together, so they must be snapshotted together.
type NovelVersionService struct {
	novelRepo   repository.NovelRepository
	chapterRepo repository.ChapterRepository
	docSvc      *NovelDocService
	versionRepo repository.NovelVersionRepository
	// db powers the transactional restore (F1-7): chapters, outline and
	// memory must move together, a partial restore is a corrupt book.
	db *gorm.DB
}

// NewNovelVersionService creates a new NovelVersionService. db is required
// for the transactional restore path; a nil db makes Restore fail closed.
func NewNovelVersionService(
	nr repository.NovelRepository,
	cr repository.ChapterRepository,
	docSvc *NovelDocService,
	vr repository.NovelVersionRepository,
	db *gorm.DB,
) *NovelVersionService {
	return &NovelVersionService{novelRepo: nr, chapterRepo: cr, docSvc: docSvc, versionRepo: vr, db: db}
}

// CreateMilestone writes an explicit whole-novel checkpoint and returns its
// summary.
//
// Always stores when asked: unlike the chapter auto-snapshot there is no
// hash-based skipping, because the author is deliberately marking a moment.
// The ContentHash is recorded for integrity only.
func (s *NovelVersionService) CreateMilestone(ctx context.Context, userID, novelID int64, label string) (*dto.NovelVersionSummary, error) {
	novel, err := s.ensureNovelExists(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	snap, err := s.bundle(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	v := &model.NovelVersion{
		UserID:       userID,
		NovelID:      novelID,
		Title:        novel.Title,
		Kind:         model.VersionKindMilestone,
		Label:        label,
		Snapshot:     datatypes.JSON(raw),
		ContentHash:  bundleHash(raw),
		ChapterCount: len(snap.Chapters),
		WordCount:    snapWordCount(snap),
	}
	if err := s.versionRepo.Create(ctx, v); err != nil {
		zap.L().Error("novel version: create milestone failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return nil, err
	}
	summary := toNovelVersionSummary(v)
	return &summary, nil
}

// List returns snapshot-free summaries of a novel's history, newest first.
func (s *NovelVersionService) List(ctx context.Context, userID, novelID int64, limit, offset int) (*dto.NovelVersionListResponse, error) {
	if err := s.ensureNovelOwned(ctx, userID, novelID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	versions, err := s.versionRepo.ListByNovel(ctx, userID, novelID, limit, offset)
	if err != nil {
		return nil, err
	}
	// Counted separately: ListByNovel is capped, the panel needs the
	// uncapped total to paginate.
	total, err := s.versionRepo.CountByNovel(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	out := make([]dto.NovelVersionSummary, 0, len(versions))
	for i := range versions {
		out = append(out, toNovelVersionSummary(&versions[i]))
	}
	return &dto.NovelVersionListResponse{Versions: out, Total: total, Limit: limit, Offset: offset}, nil
}

// Get returns a single snapshot including its bundle. The owning novel is
// re-checked through the row's own novel_id, so a version can never be read
// through a novel it does not belong to (contract C3).
func (s *NovelVersionService) Get(ctx context.Context, userID, versionID int64) (*dto.NovelVersionDetail, error) {
	v, err := s.versionRepo.GetByID(ctx, userID, versionID)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, ErrNotFound
	}
	if err := s.ensureNovelOwned(ctx, userID, v.NovelID); err != nil {
		return nil, err
	}
	detail := &dto.NovelVersionDetail{NovelVersionSummary: toNovelVersionSummary(v)}
	if len(v.Snapshot) > 0 {
		var snap dto.NovelSnapshot
		if err := json.Unmarshal(v.Snapshot, &snap); err != nil {
			zap.L().Error("novel version: snapshot is not decodable",
				zap.Int64("version_id", versionID), zap.Error(err))
			return nil, ErrInvalidInput
		}
		detail.Snapshot = &snap
	}
	return detail, nil
}

// Restore puts the whole novel back to the moment a snapshot was taken.
//
// A checkpoint of the CURRENT state is written first (kind "rollback"), so a
// restore is itself reversible — the author never loses what was on screen.
// The checkpoint is best-effort: a failure is logged and the restore proceeds,
// because refusing to restore is the worse outcome.
//
// Two modes:
//   - conservative (default, and the fallback for any unrecognized mode):
//     updates chapters that still exist; chapters deleted since the snapshot
//     are counted as Missing and skipped, chapters written since are counted
//     as Extra and left alone. Nothing is ever created or destroyed.
//   - full: additionally recreates missing chapters under their original ids
//     and deletes the extra ones, reproducing the snapshot exactly.
//
// Outline acts and memory items are always replaced wholesale in both modes —
// that is what "back to this moment" means for a whole-novel snapshot.
func (s *NovelVersionService) Restore(ctx context.Context, userID, novelID, versionID int64, mode string) (*dto.RestoreResult, error) {
	if _, err := s.ensureNovelExists(ctx, userID, novelID); err != nil {
		return nil, err
	}
	target, err := s.versionRepo.GetByID(ctx, userID, versionID)
	if err != nil {
		return nil, err
	}
	// A snapshot of another novel must not be restorable through this route
	// even for its rightful owner.
	if target == nil || target.NovelID != novelID {
		return nil, ErrNotFound
	}
	var snap dto.NovelSnapshot
	if err := json.Unmarshal(target.Snapshot, &snap); err != nil {
		zap.L().Error("novel version: snapshot is not decodable",
			zap.Int64("version_id", versionID), zap.Error(err))
		return nil, ErrInvalidInput
	}

	full := mode == RestoreModeFull
	applied := RestoreModeConservative
	if full {
		applied = RestoreModeFull
	}
	res := &dto.RestoreResult{Mode: applied}

	// 1. Checkpoint what is about to be overwritten (best-effort).
	res.CheckpointID = s.checkpoint(ctx, userID, novelID)

	if s.db == nil {
		return nil, fmt.Errorf("novel version service: database handle not wired")
	}

	// 2–5. Apply the restore atomically (F1-7): chapters (update / recreate /
	// delete), outline, memory and the word-count refresh all run inside one
	// transaction. A mid-restore failure used to strand the book half-restored
	// ("chapters rolled back, outline not"); now it either lands whole or not
	// at all — and res stays untouched on failure so the caller learns of the
	// failure before any partial counters leak out.
	txErr := s.db.Transaction(func(tx *gorm.DB) error {
		txChapters := repository.NewChapterRepository(tx)
		txDocs := s.docSvc.WithDocRepo(repository.NewNovelDocRepository(tx))

		current, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
		if err != nil {
			return err
		}
		byID := make(map[int64]*model.Chapter, len(current))
		for i := range current {
			byID[current[i].ID] = &current[i]
		}
		inBundle := make(map[int64]struct{}, len(snap.Chapters))

		// 2. Chapters present in the snapshot.
		for _, bc := range snap.Chapters {
			inBundle[bc.ID] = struct{}{}
			if cur, ok := byID[bc.ID]; ok {
				applySnapshotChapter(cur, &bc)
				if err := txChapters.Update(ctx, userID, cur); err != nil {
					zap.L().Error("novel version: chapter restore failed",
						zap.Int64("chapter_id", bc.ID), zap.Error(err))
					return err
				}
				res.Updated++
				continue
			}
			res.Missing++
			if !full {
				continue
			}
			if err := recreateChapter(ctx, txChapters, userID, novelID, &bc); err != nil {
				return err
			}
			res.Created++
		}

		// 3. Chapters written after the snapshot.
		for i := range current {
			if _, ok := inBundle[current[i].ID]; ok {
				continue
			}
			res.Extra++
			if !full {
				continue
			}
			if err := txChapters.Delete(ctx, userID, current[i].ID); err != nil {
				zap.L().Error("novel version: extra chapter delete failed",
					zap.Int64("chapter_id", current[i].ID), zap.Error(err))
				return err
			}
			res.Deleted++
		}

		// 4. Outline and memory: wholesale replacement in both modes.
		acts := snap.Outline.Acts
		if len(acts) == 0 {
			acts = emptyJSONArray
		}
		if _, err := txDocs.UpdateOutline(ctx, userID, novelID, acts, nil); err != nil {
			zap.L().Error("novel version: outline restore failed",
				zap.Int64("novel_id", novelID), zap.Error(err))
			return err
		}
		items := snap.Memory.Items
		if len(items) == 0 {
			items = emptyJSONArray
		}
		if _, err := txDocs.UpdateMemory(ctx, userID, novelID, items, nil); err != nil {
			zap.L().Error("novel version: memory restore failed",
				zap.Int64("novel_id", novelID), zap.Error(err))
			return err
		}

		// 5. Same post-write bookkeeping as ChapterService.UpdateChapter.
		return txChapters.RefreshNovelWordCount(ctx, userID, novelID)
	})
	if txErr != nil {
		return nil, txErr
	}
	return res, nil
}

// checkpoint snapshots the current whole-novel state as a rollback version so
// the restore that follows can itself be undone. Best-effort: returns 0 and
// logs when the checkpoint cannot be written.
func (s *NovelVersionService) checkpoint(ctx context.Context, userID, novelID int64) int64 {
	snap, err := s.bundle(ctx, userID, novelID)
	if err != nil {
		zap.L().Warn("novel version: build pre-restore checkpoint failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return 0
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		zap.L().Warn("novel version: marshal pre-restore checkpoint failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return 0
	}
	v := &model.NovelVersion{
		UserID:       userID,
		NovelID:      novelID,
		Kind:         model.VersionKindRollback,
		Label:        checkpointLabel,
		Snapshot:     datatypes.JSON(raw),
		ContentHash:  bundleHash(raw),
		ChapterCount: len(snap.Chapters),
		WordCount:    snapWordCount(snap),
	}
	// Title is denormalized onto the row for display; the checkpoint is
	// internal, so the novel title is only needed when it is cheap.
	if novel, err := s.novelRepo.GetByID(ctx, userID, novelID); err == nil && novel != nil {
		v.Title = novel.Title
	}
	if err := s.versionRepo.Create(ctx, v); err != nil {
		zap.L().Warn("novel version: pre-restore checkpoint failed",
			zap.Int64("novel_id", novelID), zap.Error(err))
		return 0
	}
	return v.ID
}

// recreateChapter inserts a chapter that exists in the bundle but no longer
// exists in the novel, keeping its original id.
//
// The snapshot's position is used first — that is where the chapter belonged.
// Postgres enforces a partial unique index on (novel_id, position), which a
// chapter created after the deletion can already occupy, so a collision falls
// back to appending at the end (retry once, mirroring ChapterService).
// recreateChapter re-inserts a snapshot chapter under its original id. The
// repo is a parameter so the restore transaction can pass its tx-bound
// instance (F1-7).
func recreateChapter(ctx context.Context, chapters repository.ChapterRepository, userID, novelID int64, bc *dto.NovelSnapshotChapter) error {
	chapter := snapshotChapter(bc, userID, novelID)
	err := chapters.UpsertWithID(ctx, userID, chapter)
	if isUniqueViolation(err) {
		maxPos, perr := chapters.GetMaxPosition(ctx, userID, novelID)
		if perr != nil {
			return perr
		}
		zap.L().Warn("novel version: snapshot position taken, appending restored chapter at the end",
			zap.Int64("chapter_id", bc.ID), zap.Int("position", bc.Position))
		chapter.Position = maxPos + 1
		return chapters.UpsertWithID(ctx, userID, chapter)
	}
	if err != nil {
		zap.L().Error("novel version: recreate chapter failed",
			zap.Int64("chapter_id", bc.ID), zap.Error(err))
	}
	return err
}

// bundle captures the novel's whole current state: chapters (all of them,
// including soft-deleted-free ones), outline and memory.
func (s *NovelVersionService) bundle(ctx context.Context, userID, novelID int64) (*dto.NovelSnapshot, error) {
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	snap := &dto.NovelSnapshot{
		Chapters: make([]dto.NovelSnapshotChapter, 0, len(chapters)),
	}
	for i := range chapters {
		c := &chapters[i]
		sc := dto.NovelSnapshotChapter{
			ID:        c.ID,
			Title:     c.Title,
			Status:    c.Status,
			Position:  c.Position,
			SortOrder: c.Position,
			WordCount: c.WordCount,
			VolumeID:  c.VolumeID,
		}
		if c.Content != nil {
			sc.Content = *c.Content
		}
		if len(c.ContentJSON) > 0 {
			sc.ContentJSON = json.RawMessage(c.ContentJSON)
		}
		if c.Summary != nil {
			sc.Summary = *c.Summary
		}
		snap.Chapters = append(snap.Chapters, sc)
	}
	if s.docSvc != nil {
		outline, err := s.docSvc.GetOutline(ctx, userID, novelID)
		if err != nil {
			return nil, err
		}
		if outline != nil {
			snap.Outline = dto.NovelSnapshotOutline{Acts: outline.Acts, Version: outline.Version}
		}
		memory, err := s.docSvc.GetMemory(ctx, userID, novelID)
		if err != nil {
			return nil, err
		}
		if memory != nil {
			snap.Memory = dto.NovelSnapshotMemory{Items: memory.Items, Version: memory.Version}
		}
	}
	return snap, nil
}

// ensureNovelOwned maps a missing or foreign-owned novel to ErrNotFound.
func (s *NovelVersionService) ensureNovelOwned(ctx context.Context, userID, novelID int64) error {
	_, err := s.ensureNovelExists(ctx, userID, novelID)
	return err
}

// ensureNovelExists mirrors NovelDocService.ensureNovelExists (contract C3):
// 404 semantics, never revealing another user's data.
func (s *NovelVersionService) ensureNovelExists(ctx context.Context, userID, novelID int64) (*model.Novel, error) {
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		return nil, err
	}
	if novel == nil {
		return nil, ErrNotFound
	}
	return novel, nil
}

// applySnapshotChapter overwrites the mutable fields of an existing chapter
// from its snapshot. The id (and therefore every outline chapter_id link) is
// untouched by construction.
func applySnapshotChapter(cur *model.Chapter, bc *dto.NovelSnapshotChapter) {
	content := bc.Content
	cur.Title = bc.Title
	cur.Content = &content
	cur.WordCount = bc.WordCount
	cur.Status = bc.Status
	cur.VolumeID = bc.VolumeID
	if len(bc.ContentJSON) > 0 {
		cur.ContentJSON = datatypes.JSON(bc.ContentJSON)
	} else {
		cur.ContentJSON = nil
	}
	if bc.Summary == "" {
		cur.Summary = nil
	} else {
		sum := bc.Summary
		cur.Summary = &sum
	}
}

// snapshotChapter rebuilds a Chapter model from its snapshot, ready to be
// inserted under the snapshot's original primary key.
func snapshotChapter(bc *dto.NovelSnapshotChapter, userID, novelID int64) *model.Chapter {
	ch := &model.Chapter{
		ID:        bc.ID,
		UserID:    userID,
		NovelID:   novelID,
		VolumeID:  bc.VolumeID,
		Title:     bc.Title,
		WordCount: bc.WordCount,
		Position:  bc.Position,
		Status:    bc.Status,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	content := bc.Content
	ch.Content = &content
	if len(bc.ContentJSON) > 0 {
		ch.ContentJSON = datatypes.JSON(bc.ContentJSON)
	}
	if bc.Summary != "" {
		sum := bc.Summary
		ch.Summary = &sum
	}
	if ch.Status == "" {
		ch.Status = "draft"
	}
	return ch
}

// bundleHash returns the leading 16 hex chars of sha256(bundle bytes) — the
// integrity fingerprint of a snapshot, mirroring contentHash for chapters.
func bundleHash(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16]
}

func snapWordCount(snap *dto.NovelSnapshot) int {
	total := 0
	for i := range snap.Chapters {
		total += snap.Chapters[i].WordCount
	}
	return total
}

func toNovelVersionSummary(v *model.NovelVersion) dto.NovelVersionSummary {
	return dto.NovelVersionSummary{
		ID:           v.ID,
		NovelID:      v.NovelID,
		Title:        v.Title,
		Kind:         v.Kind,
		Label:        v.Label,
		ContentHash:  v.ContentHash,
		ChapterCount: v.ChapterCount,
		WordCount:    v.WordCount,
		CreatedAt:    v.CreatedAt,
	}
}
