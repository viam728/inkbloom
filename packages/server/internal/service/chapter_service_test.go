package service

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/gorm"
)

// newTestChapterService builds a ChapterService whose stores are backed by an
// in-memory SQLite database, mirroring the harness in
// outline_sync_integration_test.go so the snapshot table is real and queried.
func newTestChapterService(t *testing.T) (*ChapterService, *gorm.DB) {
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
	if err := db.AutoMigrate(&model.Chapter{}, &model.ChapterVersion{}, &model.OutlineVersion{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	chapterRepo := repository.NewChapterRepository(db)
	versionRepo := repository.NewChapterVersionRepository(db)
	cfg := config.VersionHistoryConfig{Enabled: true}
	s := NewChapterService(chapterRepo, nil, nil, versionRepo, cfg)
	return s, db
}

// TestChapterServiceSnapshotForAgentPersistsAgentAuto proves the write-before
// snapshot (plan §七.3.1 "写前自动快照") actually lands in chapter_versions with
// the agent-auto label and a content-hash dedupe, and that nil/missing chapters
// are safe no-ops.
func TestChapterServiceSnapshotForAgentPersistsAgentAuto(t *testing.T) {
	ctx := context.Background()
	s, db := newTestChapterService(t)
	const userID, chapterID, novelID = int64(7), int64(101), int64(77)

	orig := "original text"
	chapter := &model.Chapter{
		ID:      chapterID,
		UserID:  userID,
		NovelID: novelID,
		Title:   "第一章",
		Content: &orig,
	}
	if err := db.Create(chapter).Error; err != nil {
		t.Fatalf("seed chapter: %v", err)
	}

	// First agent snapshot of this chapter.
	s.SnapshotForAgent(ctx, userID, chapterID)

	var rows []model.ChapterVersion
	if err := db.Where("chapter_id = ? AND user_id = ?", chapterID, userID).Find(&rows).Error; err != nil {
		t.Fatalf("query chapter_versions: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("after first snapshot: %d rows, want 1", len(rows))
	}
	if rows[0].Label != "agent-auto" {
		t.Errorf("label = %q, want agent-auto", rows[0].Label)
	}
	if rows[0].ContentHash != contentHash("original text") {
		t.Errorf("content_hash = %q, want %q", rows[0].ContentHash, contentHash("original text"))
	}

	// Second call with UNCHANGED content must dedupe (no new row).
	s.SnapshotForAgent(ctx, userID, chapterID)
	if err := db.Where("chapter_id = ? AND user_id = ?", chapterID, userID).Find(&rows).Error; err != nil {
		t.Fatalf("query chapter_versions: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("after dedupe snapshot: %d rows, want 1 (dedupe by content hash)", len(rows))
	}

	// Change the chapter content, then snapshot again -> a second distinct row.
	updated := "revised text"
	if err := db.Model(&model.Chapter{}).
		Where("id = ? AND user_id = ?", chapterID, userID).
		Update("content", updated).Error; err != nil {
		t.Fatalf("update chapter content: %v", err)
	}
	s.SnapshotForAgent(ctx, userID, chapterID)
	if err := db.Where("chapter_id = ? AND user_id = ?", chapterID, userID).Find(&rows).Error; err != nil {
		t.Fatalf("query chapter_versions: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("after content change: %d rows, want 2 (distinct content each captured)", len(rows))
	}

	// No-op cases: nil content and a non-existent chapter must not panic or
	// add rows.
	nilContent := &model.Chapter{ID: int64(202), UserID: userID, NovelID: novelID, Title: "空章节"}
	if err := db.Create(nilContent).Error; err != nil {
		t.Fatalf("seed nil-content chapter: %v", err)
	}
	s.SnapshotForAgent(ctx, userID, int64(202))  // nil content -> no-op
	s.SnapshotForAgent(ctx, userID, int64(99999)) // non-existent -> no-op
	if err := db.Where("chapter_id = ? AND user_id = ?", chapterID, userID).Find(&rows).Error; err != nil {
		t.Fatalf("query chapter_versions: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("after no-op snapshots: %d rows, want 2 (no new rows)", len(rows))
	}
}
