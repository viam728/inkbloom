package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// newTestStoryService builds a StoryService whose stores are backed by an
// on-disk SQLite database, mirroring the harness in
// novel_version_service_test.go so every collaborator is real.
//
// The pool is capped at one connection: SQLite cannot serve concurrent
// writers, and capping the pool keeps the concurrency test focused on the
// per-job mutex / key-generation logic instead of driver lock errors.
func newTestStoryService(t *testing.T) (*StoryService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "storyadopt.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	// Registered after t.TempDir(), so it runs before its cleanup: Windows
	// refuses to delete an SQLite file that is still open.
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if sqlDB, err := db.DB(); err == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.AutoMigrate(&model.Novel{}, &model.Chapter{}, &model.StoryJob{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	novelRepo := repository.NewNovelRepository(db)
	chapterRepo := repository.NewChapterRepository(db)
	docSvc := NewNovelDocService(novelRepo, repository.NewNovelDocRepository(db), chapterRepo, nil)
	chapterSvc := NewChapterService(chapterRepo, novelRepo, nil, nil, config.VersionHistoryConfig{})
	svc := NewStoryService(
		repository.NewStoryJobRepository(db), novelRepo, chapterRepo,
		docSvc, chapterSvc, nil, "http://127.0.0.1:1", zap.NewNop(),
	)
	return svc, db
}

// seedStoryJob inserts a novel + one pending story job for adopt tests.
func seedStoryJob(t *testing.T, db *gorm.DB, userID, novelID int64) *model.StoryJob {
	t.Helper()
	novel := &model.Novel{UserID: userID, Title: "测试作品"}
	novel.ID = novelID
	if err := db.Create(novel).Error; err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	job := &model.StoryJob{
		UserID:       userID,
		NovelID:      novelID,
		Title:        "剑试天下",
		Logline:      "少年负剑出山，搅动江湖风云",
		Stage:        model.StageIdea,
		Status:       model.StoryJobPending,
		TotalSteps:   7,
		StagePayload: []byte("{}"),
		Config:       []byte("{}"),
	}
	if err := db.Create(job).Error; err != nil {
		t.Fatalf("seed story job: %v", err)
	}
	return job
}

// adoptedKeysOf decodes the adopted chapter keys from a job response.
func adoptedKeysOf(t *testing.T, resp *dto.StoryJobResponse) []string {
	t.Helper()
	var payload struct {
		Adopted []struct {
			ChapterKey string `json:"chapter_key"`
		} `json:"adopted"`
	}
	if err := json.Unmarshal(resp.StagePayload, &payload); err != nil {
		t.Fatalf("decode stage_payload: %v", err)
	}
	keys := make([]string, 0, len(payload.Adopted))
	for _, a := range payload.Adopted {
		keys = append(keys, a.ChapterKey)
	}
	return keys
}

// chapterCountOf counts the real chapters of a novel.
func chapterCountOf(t *testing.T, db *gorm.DB, novelID int64) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&model.Chapter{}).Where("novel_id = ?", novelID).Count(&n).Error; err != nil {
		t.Fatalf("count chapters: %v", err)
	}
	return n
}

// TestAdoptChapterRepeatedKeyIsIdempotent covers acceptance case §4.4-1:
// the same {job_id, chapter_key} posted twice must leave ONE chapter behind,
// keep ChapterKeys stable, and return 200-equivalent (no error) both times.
// A third adopt with a DIFFERENT key still creates a chapter — the semantic
// of "regenerate then re-adopt" is preserved.
func TestAdoptChapterRepeatedKeyIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStoryService(t)
	const userID, novelID = int64(1), int64(301)
	job := seedStoryJob(t, db, userID, novelID)
	req := &dto.AdoptChapterRequest{ChapterKey: "ch-1", Title: "第一章 出山", Content: "负剑出山"}

	first, err := s.AdoptChapter(ctx, userID, job.ID, req)
	if err != nil {
		t.Fatalf("first adopt: %v", err)
	}
	if first.ChapterKeys != 1 {
		t.Errorf("first adopt ChapterKeys = %d, want 1", first.ChapterKeys)
	}

	// Replay: same key, must be a no-op that still succeeds.
	second, err := s.AdoptChapter(ctx, userID, job.ID, req)
	if err != nil {
		t.Fatalf("replayed adopt (must be idempotent, not an error): %v", err)
	}
	if second.ChapterKeys != 1 {
		t.Errorf("replayed adopt ChapterKeys = %d, want 1 (unchanged)", second.ChapterKeys)
	}
	if keys := adoptedKeysOf(t, second); len(keys) != 1 {
		t.Errorf("replayed adopt left %d adopted records, want 1: %v", len(keys), keys)
	}
	if n := chapterCountOf(t, db, novelID); n != 1 {
		t.Errorf("novel has %d chapters after replay, want 1", n)
	}

	// A different key still creates a real chapter.
	third, err := s.AdoptChapter(ctx, userID, job.ID, &dto.AdoptChapterRequest{
		ChapterKey: "ch-2", Title: "第二章 雨战", Content: "雨夜初战",
	})
	if err != nil {
		t.Fatalf("adopt with new key: %v", err)
	}
	if third.ChapterKeys != 2 {
		t.Errorf("adopt with new key ChapterKeys = %d, want 2", third.ChapterKeys)
	}
	if n := chapterCountOf(t, db, novelID); n != 2 {
		t.Errorf("novel has %d chapters after new-key adopt, want 2", n)
	}

	// C3 isolation: another user must not adopt (nor discover) the job.
	if _, err := s.AdoptChapter(ctx, 99, job.ID, req); err != ErrStoryJobNotFound {
		t.Errorf("cross-user adopt error = %v, want ErrStoryJobNotFound", err)
	}
	if n := chapterCountOf(t, db, novelID); n != 2 {
		t.Errorf("cross-user adopt wrote chapters: %d, want 2", n)
	}
}

// TestAdoptChapterEmptyKeyGeneratesSequentialKey covers acceptance case
// §4.4-2: an empty chapter_key is generated server-side as ch-{n+1}, and
// successive empty-key adopts keep advancing the sequence.
func TestAdoptChapterEmptyKeyGeneratesSequentialKey(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStoryService(t)
	const userID, novelID = int64(1), int64(302)
	job := seedStoryJob(t, db, userID, novelID)

	first, err := s.AdoptChapter(ctx, userID, job.ID, &dto.AdoptChapterRequest{Title: "第一章", Content: "一章"})
	if err != nil {
		t.Fatalf("empty-key adopt #1: %v", err)
	}
	keys := adoptedKeysOf(t, first)
	if len(keys) != 1 || keys[0] != "ch-1" {
		t.Errorf("generated key = %v, want [ch-1]", keys)
	}

	second, err := s.AdoptChapter(ctx, userID, job.ID, &dto.AdoptChapterRequest{Title: "第二章", Content: "二章"})
	if err != nil {
		t.Fatalf("empty-key adopt #2: %v", err)
	}
	keys = adoptedKeysOf(t, second)
	if len(keys) != 2 || keys[1] != "ch-2" {
		t.Errorf("generated keys = %v, want [ch-1 ch-2]", keys)
	}
	if n := chapterCountOf(t, db, novelID); n != 2 {
		t.Errorf("novel has %d chapters, want 2", n)
	}
}

// TestAdoptChapterConcurrentEmptyKeysGetDistinctKeys covers acceptance case
// §4.4-3: two concurrent empty-key adopts must each become a real chapter
// with distinct generated keys — serialised by the per-job mutex, not
// collapsed into duplicates.
func TestAdoptChapterConcurrentEmptyKeysGetDistinctKeys(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStoryService(t)
	const userID, novelID = int64(1), int64(303)
	job := seedStoryJob(t, db, userID, novelID)

	type outcome struct {
		resp *dto.StoryJobResponse
		err  error
	}
	results := make([]outcome, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := s.AdoptChapter(ctx, userID, job.ID, &dto.AdoptChapterRequest{
				Title: "并发采纳章", Content: "并发正文",
			})
			results[i] = outcome{resp, err}
		}(i)
	}
	wg.Wait()

	for i, r := range results {
		if r.err != nil {
			t.Fatalf("concurrent adopt #%d: %v", i, r.err)
		}
	}
	if results[0].resp == nil || results[1].resp == nil {
		t.Fatal("concurrent adopts returned nil responses")
	}

	// Both jobs report the final state: two adopted records, distinct keys.
	keys := adoptedKeysOf(t, results[0].resp)
	if len(keys) != 2 || keys[0] == keys[1] {
		t.Errorf("concurrent empty-key adopts produced keys %v, want two distinct", keys)
	}
	if results[0].resp.ChapterKeys != 2 {
		t.Errorf("ChapterKeys = %d, want 2", results[0].resp.ChapterKeys)
	}
	if n := chapterCountOf(t, db, novelID); n != 2 {
		t.Errorf("novel has %d chapters after concurrent adopts, want 2", n)
	}
}
