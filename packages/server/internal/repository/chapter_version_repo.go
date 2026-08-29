package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// ChapterVersionRepository defines the interface for chapter snapshot access.
// Every method is scoped by userID (contract C3).
type ChapterVersionRepository interface {
	Create(ctx context.Context, v *model.ChapterVersion) error
	GetByID(ctx context.Context, userID, id int64) (*model.ChapterVersion, error)
	// ListByChapter returns content-free summaries ordered newest-first.
	ListByChapter(ctx context.Context, userID, chapterID int64, limit, offset int) ([]model.ChapterVersion, error)
	// Latest returns the newest snapshot of any kind. Used by the auto-snapshot
	// throttle and hash dedupe: a fresh milestone makes a following auto
	// snapshot redundant, so the throttle considers every kind, not just auto.
	Latest(ctx context.Context, userID, chapterID int64) (*model.ChapterVersion, error)
	// PruneAuto keeps only the newest `keep` auto snapshots for the chapter.
	// Milestone / rollback / import versions are never touched.
	PruneAuto(ctx context.Context, userID, chapterID int64, keep int) (int64, error)
	// PruneAutoBefore deletes auto snapshots of a user older than cutoff.
	// Only VersionKindAuto rows are touched — milestone / rollback are
	// deliberately kept forever so deliberate checkpoints are never lost.
	PruneAutoBefore(ctx context.Context, userID int64, cutoff time.Time) (int64, error)
	// ListUsersWithAuto returns distinct user ids that currently hold at
	// least one auto snapshot. Drives the retention sweep (A07).
	ListUsersWithAuto(ctx context.Context) ([]int64, error)
	// CountByChapter counts every snapshot of one chapter (any kind). Used to
	// drive list pagination totals.
	CountByChapter(ctx context.Context, userID, chapterID int64) (int64, error)
	// CountSince counts snapshots created at or after `since` for the user
	// (across all chapters). Used by the retention sweep.
	CountSince(ctx context.Context, userID int64, since time.Time) (int64, error)
}

type chapterVersionRepository struct {
	db *gorm.DB
}

// NewChapterVersionRepository creates a new ChapterVersionRepository.
func NewChapterVersionRepository(db *gorm.DB) ChapterVersionRepository {
	return &chapterVersionRepository{db: db}
}

// summaryColumns excludes the (potentially large) content payload so listing a
// chapter's history never drags whole chapter bodies over the wire.
const summaryColumns = "id, user_id, chapter_id, novel_id, title, word_count, kind, label, content_hash, created_at"

func (r *chapterVersionRepository) Create(ctx context.Context, v *model.ChapterVersion) error {
	return r.db.WithContext(ctx).Create(v).Error
}

func (r *chapterVersionRepository) GetByID(ctx context.Context, userID, id int64) (*model.ChapterVersion, error) {
	var v model.ChapterVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		First(&v, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

func (r *chapterVersionRepository) ListByChapter(ctx context.Context, userID, chapterID int64, limit, offset int) ([]model.ChapterVersion, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var versions []model.ChapterVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("chapter_id = ?", chapterID).
		Select(summaryColumns).
		Order("created_at DESC").
		Limit(limit).
		Offset(offset).
		Find(&versions).Error
	if err != nil {
		return nil, err
	}
	return versions, nil
}

func (r *chapterVersionRepository) Latest(ctx context.Context, userID, chapterID int64) (*model.ChapterVersion, error) {
	var v model.ChapterVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("chapter_id = ?", chapterID).
		Select(summaryColumns).
		Order("created_at DESC").
		First(&v).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &v, nil
}

// PruneAuto deletes all but the newest `keep` auto snapshots of a chapter.
//
// It resolves the retention boundary first and deletes strictly older rows
// instead of using a "NOT IN (subquery with LIMIT)" form: correlated subqueries
// over the same table behave inconsistently between PostgreSQL and SQLite, and
// the construction plan (contract C11) requires both dialects to work.
//
// Rows sharing the boundary timestamp are kept. The A03 throttle writes auto
// snapshots at most once per 5 minutes, so exact-timestamp ties are not
// expected in practice; keeping them errs on the side of not deleting data.
func (r *chapterVersionRepository) PruneAuto(ctx context.Context, userID, chapterID int64, keep int) (int64, error) {
	if keep <= 0 {
		keep = 20
	}
	base := r.db.WithContext(ctx).
		Model(&model.ChapterVersion{}).
		Where("user_id = ? AND chapter_id = ? AND kind = ?", userID, chapterID, model.VersionKindAuto)

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return 0, err
	}
	if total <= int64(keep) {
		return 0, nil
	}

	var boundary model.ChapterVersion
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("chapter_id = ? AND kind = ?", chapterID, model.VersionKindAuto).
		Select("id, created_at").
		Order("created_at DESC").
		Offset(keep - 1).
		Limit(1).
		First(&boundary).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}

	res := r.db.WithContext(ctx).
		Where("user_id = ? AND chapter_id = ? AND kind = ? AND created_at < ?",
			userID, chapterID, model.VersionKindAuto, boundary.CreatedAt).
		Delete(&model.ChapterVersion{})
	return res.RowsAffected, res.Error
}

func (r *chapterVersionRepository) PruneAutoBefore(ctx context.Context, userID int64, cutoff time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Where("user_id = ? AND kind = ? AND created_at < ?",
			userID, model.VersionKindAuto, cutoff).
		Delete(&model.ChapterVersion{})
	return res.RowsAffected, res.Error
}

func (r *chapterVersionRepository) ListUsersWithAuto(ctx context.Context) ([]int64, error) {
	var ids []int64
	err := r.db.WithContext(ctx).
		Model(&model.ChapterVersion{}).
		Where("kind = ?", model.VersionKindAuto).
		Distinct().
		Pluck("user_id", &ids).Error
	return ids, err
}

func (r *chapterVersionRepository) CountByChapter(ctx context.Context, userID, chapterID int64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.ChapterVersion{}).
		Scopes(scope.ForUser(userID)).
		Where("chapter_id = ?", chapterID).
		Count(&n).Error
	return n, err
}

func (r *chapterVersionRepository) CountSince(ctx context.Context, userID int64, since time.Time) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.ChapterVersion{}).
		Scopes(scope.ForUser(userID)).
		Where("created_at >= ?", since).
		Count(&n).Error
	return n, err
}
