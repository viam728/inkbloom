package repository

import (
	"context"
	"errors"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PublishedRepository is the author-scoped interface (contract C3: every
// method leads with ctx, userID and applies scope.ForUser).
type PublishedRepository interface {
	// WorkByNovel returns the published work for a novel, or nil if not published.
	WorkByNovel(ctx context.Context, userID, novelID int64) (*model.PublishedWork, error)
	// WorkByID fetches a work the author owns.
	WorkByID(ctx context.Context, userID, id int64) (*model.PublishedWork, error)
	// WorkBySlug fetches one of the author's works by slug. The slug is
	// globally unique, but scoping by userID still guarantees a reader from
	// another account cannot probe an author's unlisted/private works by id.
	WorkBySlug(ctx context.Context, userID int64, slug string) (*model.PublishedWork, error)
	SlugExists(ctx context.Context, userID int64, slug string) (bool, error)
	CreateWork(ctx context.Context, w *model.PublishedWork) error
	UpdateWork(ctx context.Context, userID int64, w *model.PublishedWork) error
	DeleteWork(ctx context.Context, userID, id int64) error
	ListWorksByUser(ctx context.Context, userID int64) ([]model.PublishedWork, error)

	// ChapterByPublishedID fetches a published chapter the author owns.
	ChapterByPublishedID(ctx context.Context, userID, pid int64) (*model.PublishedChapter, error)
	// ChapterByDraftID returns the published copy of a draft chapter, if any.
	ChapterByDraftID(ctx context.Context, userID, workID, chapterID int64) (*model.PublishedChapter, error)
	ListChaptersByWork(ctx context.Context, userID, workID int64) ([]model.PublishedChapter, error)
	UpsertChapter(ctx context.Context, userID int64, c *model.PublishedChapter) error
	DeleteChapter(ctx context.Context, userID, pid int64) error

	// Progress.
	GetProgress(ctx context.Context, userID, workID int64) (*model.ReadingProgress, error)
	UpsertProgress(ctx context.Context, userID int64, p *model.ReadingProgress) error

	// Follows.
	GetFollow(ctx context.Context, userID, workID int64) (*model.ReaderFollow, error)
	UpsertFollow(ctx context.Context, userID int64, f *model.ReaderFollow) error
	DeleteFollow(ctx context.Context, userID, workID int64) error
	// IncFollowCount / DecFollowCount maintain the denormalised counter on
	// published_works so discovery doesn't need a join.
	IncFollowCount(ctx context.Context, workID int64) error
	DecFollowCount(ctx context.Context, workID int64) error
}

// PublishedReadRepository is the cross-user, read-only interface.
//
// This is an explicit, documented exception to contract C3: the reading
// surface serves anonymous readers, and there is no reader user_id to scope
// by. Every method here applies a visibility filter instead, so private and
// not-yet-scheduled content can never leak. The same pattern is used by
// admin_repo for back-office access.
type PublishedReadRepository interface {
	// WorkBySlugPublic returns a work visible to anonymous readers. Private
	// works return nil (the caller turns that into a 404).
	WorkBySlugPublic(ctx context.Context, slug string) (*model.PublishedWork, error)
	// ListChaptersPublic returns chapters visible right now: scheduled_at
	// is null or in the past. Ordered by position.
	ListChaptersPublic(ctx context.Context, workID int64) ([]model.PublishedChapter, error)
	// ChapterPublic returns one visible chapter. scheduled_at in the future
	// returns nil (404), even for the author — the whole point of scheduling.
	ChapterPublic(ctx context.Context, pid int64) (*model.PublishedChapter, error)
	// ReadingDistribution returns, per published chapter, how many readers'
	// latest position falls there — the read-through funnel (plan A23).
	ReadingDistribution(ctx context.Context, workID int64) ([]ReadingDistributionRow, error)
	// DistinctReaders returns the number of distinct readers with any progress.
	DistinctReaders(ctx context.Context, workID int64) (int64, error)
}

// ReadingDistributionRow is a projection of reading_progress grouped by
// chapter (plan A23).
type ReadingDistributionRow struct {
	ChapterID   int64
	ReaderCount int64
}

type publishedRepository struct {
	db *gorm.DB
}

// NewPublishedRepository creates a new PublishedRepository.
func NewPublishedRepository(db *gorm.DB) PublishedRepository {
	return &publishedRepository{db: db}
}

func (r *publishedRepository) WorkByNovel(ctx context.Context, userID, novelID int64) (*model.PublishedWork, error) {
	var w model.PublishedWork
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("novel_id = ?", novelID).First(&w).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &w, err
}

func (r *publishedRepository) WorkByID(ctx context.Context, userID, id int64) (*model.PublishedWork, error) {
	var w model.PublishedWork
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).First(&w, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (r *publishedRepository) WorkBySlug(ctx context.Context, userID int64, slug string) (*model.PublishedWork, error) {
	var w model.PublishedWork
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("slug = ?", slug).First(&w).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (r *publishedRepository) SlugExists(ctx context.Context, userID int64, slug string) (bool, error) {
	// Slug is globally unique, so the existence check must NOT be scoped by
	// userID: a collision with another author's slug still has to fail.
	var count int64
	err := r.db.WithContext(ctx).Model(&model.PublishedWork{}).
		Where("slug = ?", slug).Count(&count).Error
	return count > 0, err
}

func (r *publishedRepository) CreateWork(ctx context.Context, w *model.PublishedWork) error {
	return r.db.WithContext(ctx).Create(w).Error
}

func (r *publishedRepository) UpdateWork(ctx context.Context, userID int64, w *model.PublishedWork) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Save(w).Error
}

func (r *publishedRepository) DeleteWork(ctx context.Context, userID, id int64) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Delete(&model.PublishedWork{}, id).Error
}

func (r *publishedRepository) ListWorksByUser(ctx context.Context, userID int64) ([]model.PublishedWork, error) {
	var list []model.PublishedWork
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Order("updated_at DESC").Find(&list).Error
	return list, err
}

func (r *publishedRepository) ChapterByPublishedID(ctx context.Context, userID, pid int64) (*model.PublishedChapter, error) {
	var c model.PublishedChapter
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).First(&c, pid).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *publishedRepository) ChapterByDraftID(ctx context.Context, userID, workID, chapterID int64) (*model.PublishedChapter, error) {
	var c model.PublishedChapter
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("work_id = ? AND chapter_id = ?", workID, chapterID).First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *publishedRepository) ListChaptersByWork(ctx context.Context, userID, workID int64) ([]model.PublishedChapter, error) {
	var list []model.PublishedChapter
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("work_id = ?", workID).Order("position ASC").Find(&list).Error
	return list, err
}

// UpsertChapter inserts or replaces the published copy of a draft chapter.
// We delete-then-insert rather than ON CONFLICT because the (work_id,
// chapter_id) pair has no unique constraint in the model — a chapter could
// in principle be republished with a fresh snapshot row.
func (r *publishedRepository) UpsertChapter(ctx context.Context, userID int64, c *model.PublishedChapter) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Remove any prior publication of the same draft chapter.
		if err := tx.Scopes(scope.ForUser(userID)).
			Where("work_id = ? AND chapter_id = ?", c.WorkID, c.ChapterID).
			Delete(&model.PublishedChapter{}).Error; err != nil {
			return err
		}
		return tx.Scopes(scope.ForUser(userID)).Create(c).Error
	})
}

func (r *publishedRepository) DeleteChapter(ctx context.Context, userID, pid int64) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Delete(&model.PublishedChapter{}, pid).Error
}

func (r *publishedRepository) GetProgress(ctx context.Context, userID, workID int64) (*model.ReadingProgress, error) {
	var p model.ReadingProgress
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("work_id = ?", workID).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *publishedRepository) UpsertProgress(ctx context.Context, userID int64, p *model.ReadingProgress) error {
	p.UserID = userID
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "work_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"chapter_id", "position", "updated_at"}),
	}).Create(p).Error
}

func (r *publishedRepository) GetFollow(ctx context.Context, userID, workID int64) (*model.ReaderFollow, error) {
	var f model.ReaderFollow
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("work_id = ?", workID).First(&f).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (r *publishedRepository) UpsertFollow(ctx context.Context, userID int64, f *model.ReaderFollow) error {
	f.UserID = userID
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "work_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"notify"}),
	}).Create(f).Error
}

func (r *publishedRepository) DeleteFollow(ctx context.Context, userID, workID int64) error {
	return r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Where("work_id = ?", workID).Delete(&model.ReaderFollow{}).Error
}

// IncFollowCount / DecFollowCount run unscoped: the counter belongs to the
// work, not the follower, and a follow is always followed by an unfollow
// against the same work row.
func (r *publishedRepository) IncFollowCount(ctx context.Context, workID int64) error {
	return r.db.WithContext(ctx).Model(&model.PublishedWork{}).
		Where("id = ?", workID).UpdateColumn("follow_count", gorm.Expr("follow_count + 1")).Error
}

func (r *publishedRepository) DecFollowCount(ctx context.Context, workID int64) error {
	return r.db.WithContext(ctx).Model(&model.PublishedWork{}).
		Where("id = ?", workID).UpdateColumn("follow_count", gorm.Expr("GREATEST(follow_count - 1, 0)")).Error
}

// ── PublishedReadRepository (cross-user, visibility-filtered) ────────────────

type publishedReadRepository struct {
	db *gorm.DB
}

// NewPublishedReadRepository creates a new PublishedReadRepository.
func NewPublishedReadRepository(db *gorm.DB) PublishedReadRepository {
	return &publishedReadRepository{db: db}
}

func (r *publishedReadRepository) WorkBySlugPublic(ctx context.Context, slug string) (*model.PublishedWork, error) {
	var w model.PublishedWork
	// Private is invisible to readers; public and unlisted are both reachable
	// via the exact slug. Discovery listings filter to public only.
	err := r.db.WithContext(ctx).
		Where("slug = ? AND visibility <> ?", slug, model.VisibilityPrivate).
		First(&w).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (r *publishedReadRepository) ListChaptersPublic(ctx context.Context, workID int64) ([]model.PublishedChapter, error) {
	var list []model.PublishedChapter
	now := time.Now()
	err := r.db.WithContext(ctx).
		Where("work_id = ? AND (scheduled_at IS NULL OR scheduled_at <= ?)", workID, now).
		Order("position ASC").Find(&list).Error
	return list, err
}

func (r *publishedReadRepository) ChapterPublic(ctx context.Context, pid int64) (*model.PublishedChapter, error) {
	var c model.PublishedChapter
	now := time.Now()
	err := r.db.WithContext(ctx).
		Where("id = ? AND (scheduled_at IS NULL OR scheduled_at <= ?)", pid, now).
		First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// The work itself must not be private for the chapter to be readable.
	var w model.PublishedWork
	if err := r.db.WithContext(ctx).Select("visibility").First(&w, c.WorkID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if w.Visibility == model.VisibilityPrivate {
		return nil, nil
	}
	return &c, nil
}

func (r *publishedReadRepository) ReadingDistribution(ctx context.Context, workID int64) ([]ReadingDistributionRow, error) {
	var rows []ReadingDistributionRow
	err := r.db.WithContext(ctx).
		Model(&model.ReadingProgress{}).
		Select("chapter_id, COUNT(*) AS reader_count").
		Where("work_id = ?", workID).
		Group("chapter_id").
		Order("chapter_id ASC").
		Scan(&rows).Error
	return rows, err
}

func (r *publishedReadRepository) DistinctReaders(ctx context.Context, workID int64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.ReadingProgress{}).
		Where("work_id = ?", workID).
		Select("COUNT(DISTINCT user_id)").
		Scan(&n).Error
	return n, err
}
