package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/kvstore"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// newTestChapterService builds a ChapterService backed by an in-memory SQLite
// database (mirrors the outline integration harness). Only ListChaptersByNovel,
// GetChapterByTitle and create_chapter dedupe are exercised here, none of which
// touch the version cache, so a nil CacheManager and nil versionRepo are safe.
// Routes are user-scoped via the scoped repository methods (contract C3).
func newTestChapterServiceForAgent(t *testing.T) (*ChapterService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "chapter.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.Chapter{}, &model.ChapterVersion{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	cr := repository.NewChapterRepository(db)
	nr := repository.NewNovelRepository(db)
	cs := NewChapterService(cr, nr, nil, nil, config.VersionHistoryConfig{})
	return cs, db
}

// TestGetChapterByTitleResolvesOrdinal is the regression test for Q5: a chapter
// whose raw title is "余生长歌" must be resolved by the ordinal-wrapped query
// "第48章《余生长歌》" via outlineTitleKey normalization.
func TestGetChapterByTitleResolvesOrdinal(t *testing.T) {
	cs, db := newTestChapterServiceForAgent(t)
	const userID, novelID = int64(1), int64(51)
	seedNovel(t, db, userID, novelID)

	if _, err := cs.CreateChapter(context.Background(), userID, &dto.CreateChapterRequest{
		NovelID: novelID, Title: "余生长歌",
	}); err != nil {
		t.Fatalf("seed chapter: %v", err)
	}

	got, err := cs.GetChapterByTitle(context.Background(), userID, novelID, "第48章《余生长歌》")
	if err != nil {
		t.Fatalf("GetChapterByTitle: %v", err)
	}
	if got == nil {
		t.Fatal("expected a match for '第48章《余生长歌》', got nil")
	}
	if got.Title != "余生长歌" {
		t.Errorf("matched title = %q, want %q", got.Title, "余生长歌")
	}

	// A non-matching query must return nil (found:false).
	none, err := cs.GetChapterByTitle(context.Background(), userID, novelID, "不存在的章节xyz")
	if err != nil {
		t.Fatalf("GetChapterByTitle (no match): %v", err)
	}
	if none != nil {
		t.Errorf("expected nil for non-matching query, got %+v", none)
	}
}

// TestAgentGetChapterByTitleTool exercises the Agent tool dispatch path for
// get_chapter_by_title (found + not-found), asserting the exact JSON shape the
// LLM consumes.
func TestAgentGetChapterByTitleTool(t *testing.T) {
	cs, db := newTestChapterServiceForAgent(t)
	const userID, novelID = int64(1), int64(52)
	seedNovel(t, db, userID, novelID)
	if _, err := cs.CreateChapter(context.Background(), userID, &dto.CreateChapterRequest{
		NovelID: novelID, Title: "余生长歌",
	}); err != nil {
		t.Fatalf("seed chapter: %v", err)
	}
	agent := NewAgentService(nil, cs, nil, nil, "http://127.0.0.1:1", zap.NewNop())

	// Found.
	res := agent.executeTool(context.Background(), userID, novelID, agentToolCall{
		Name:      "get_chapter_by_title",
		Arguments: `{"novel_id":52,"title":"第48章《余生长歌》"}`,
	})
	var found map[string]any
	if err := json.Unmarshal([]byte(res), &found); err != nil {
		t.Fatalf("decode %q: %v", res, err)
	}
	if found["found"] != true {
		t.Fatalf("expected found:true, got %s", res)
	}
	if found["title"] != "余生长歌" {
		t.Errorf("title = %v, want 余生长歌", found["title"])
	}

	// Not found.
	res = agent.executeTool(context.Background(), userID, novelID, agentToolCall{
		Name:      "get_chapter_by_title",
		Arguments: `{"novel_id":52,"title":"没有这一章"}`,
	})
	var miss map[string]any
	if err := json.Unmarshal([]byte(res), &miss); err != nil {
		t.Fatalf("decode %q: %v", res, err)
	}
	if miss["found"] != false {
		t.Errorf("expected found:false, got %s", res)
	}
}

// TestAgentCreateChapterDedupe is the regression test for R2: create_chapter
// must NOT create a twin when an existing chapter already has the same
// normalized title. The ordinal-wrapped "第48章《余生长歌》" must resolve to the
// already-existing "余生长歌" chapter and return a warning instead of a new id.
func TestAgentCreateChapterDedupe(t *testing.T) {
	cs, db := newTestChapterServiceForAgent(t)
	const userID, novelID = int64(1), int64(53)
	seedNovel(t, db, userID, novelID)

	existing, err := cs.CreateChapter(context.Background(), userID, &dto.CreateChapterRequest{
		NovelID: novelID, Title: "余生长歌",
	})
	if err != nil {
		t.Fatalf("seed chapter: %v", err)
	}
	agent := NewAgentService(nil, cs, nil, nil, "http://127.0.0.1:1", zap.NewNop())

	res := agent.executeTool(context.Background(), userID, novelID, agentToolCall{
		Name:      "create_chapter",
		Arguments: `{"novel_id":53,"title":"第48章《余生长歌》"}`,
	})
	var r map[string]any
	if err := json.Unmarshal([]byte(res), &r); err != nil {
		t.Fatalf("decode %q: %v", res, err)
	}
	if r["warning"] == nil {
		t.Fatalf("expected dedupe warning, got %s", res)
	}
	if int64(r["chapter_id"].(float64)) != existing.ID {
		t.Errorf("chapter_id = %v, want existing %d", r["chapter_id"], existing.ID)
	}

	// No twin chapter must have been created.
	list, err := cs.ListChaptersByNovel(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("ListChaptersByNovel: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 chapter after dedupe, got %d", len(list))
	}
}

// TestAgentWriteChapterMissingChapterFailsFast is the regression for B4: a
// write_chapter against a non-existent chapter_id must fail BEFORE any LLM
// generation. With the test AI URL unreachable, reaching the LLM would produce
// "生成失败"; the "不存在" message proves the existence check now runs first.
func TestAgentWriteChapterMissingChapterFailsFast(t *testing.T) {
	const userID, novelID = int64(1), int64(55)
	dsn := "file:" + filepath.Join(t.TempDir(), "chapter.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.Chapter{}, &model.ChapterVersion{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	seedNovel(t, db, userID, novelID)
	cs := NewChapterService(repository.NewChapterRepository(db), repository.NewNovelRepository(db),
		cache.NewCacheManager(kvstore.NewMemStore(), zap.NewNop()), nil, config.VersionHistoryConfig{})
	agent := NewAgentService(nil, cs, nil, nil, "http://127.0.0.1:1", zap.NewNop())

	res := agent.executeTool(context.Background(), userID, novelID, agentToolCall{
		Name:      "write_chapter",
		Arguments: `{"novel_id":55,"chapter_id":999999,"instruction":"写点什么"}`,
	})
	if !strings.Contains(res, "不存在") {
		t.Fatalf("expected '不存在' fast-fail before LLM, got %s", res)
	}
}

// TestAgentCreateChapterNewTitleStillCreates confirms the dedupe guard does not
// block legitimate new chapters: a genuinely new title creates as before.
func TestAgentCreateChapterNewTitleStillCreates(t *testing.T) {
	cs, db := newTestChapterServiceForAgent(t)
	const userID, novelID = int64(1), int64(54)
	seedNovel(t, db, userID, novelID)
	agent := NewAgentService(nil, cs, nil, nil, "http://127.0.0.1:1", zap.NewNop())

	res := agent.executeTool(context.Background(), userID, novelID, agentToolCall{
		Name:      "create_chapter",
		Arguments: `{"novel_id":54,"title":"全新的章节"}`,
	})
	var r map[string]any
	if err := json.Unmarshal([]byte(res), &r); err != nil {
		t.Fatalf("decode %q: %v", res, err)
	}
	if r["warning"] != nil {
		t.Errorf("unexpected dedupe warning on new title: %s", res)
	}
	if r["chapter_id"] == nil {
		t.Fatalf("expected a new chapter_id, got %s", res)
	}
	list, err := cs.ListChaptersByNovel(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("ListChaptersByNovel: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 chapter, got %d", len(list))
	}
}
