package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/gorm"
)

// newTestNovelVersionService builds a NovelVersionService whose stores are
// backed by an on-disk SQLite database, mirroring the harness in
// outline_sync_integration_test.go so every collaborator is real.
//
// SQLite also proves the C11 dual-mode constraint: Snapshot is
// datatypes.JSON — jsonb on PostgreSQL, text on SQLite — and nothing in the
// service issues engine-specific SQL.
func newTestNovelVersionService(t *testing.T) (*NovelVersionService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "novelversion.db") + "?cache=shared"
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
	if err := db.AutoMigrate(&model.Novel{}, &model.Chapter{},
		&model.NovelOutline{}, &model.NovelMemory{}, &model.NovelVersion{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	novelRepo := repository.NewNovelRepository(db)
	chapterRepo := repository.NewChapterRepository(db)
	docSvc := NewNovelDocService(novelRepo, repository.NewNovelDocRepository(db), chapterRepo, nil)
	return NewNovelVersionService(novelRepo, chapterRepo, docSvc, repository.NewNovelVersionRepository(db)), db
}

// seedNovelVersionChapter inserts a chapter with an explicit id so tests can
// reason about stable ids (outline nodes reference them via chapter_id).
func seedNovelVersionChapter(t *testing.T, db *gorm.DB, userID, novelID, id int64, title, content string) {
	t.Helper()
	body := content
	ch := &model.Chapter{
		ID:        id,
		UserID:    userID,
		NovelID:   novelID,
		Title:     title,
		Content:   &body,
		WordCount: len([]rune(content)),
		Position:  int(id),
		Status:    "draft",
	}
	if err := db.Create(ch).Error; err != nil {
		t.Fatalf("seed chapter %d: %v", id, err)
	}
}

// chapterContentOf returns the stored content of a chapter ("" when absent).
func chapterContentOf(t *testing.T, db *gorm.DB, id int64) (string, bool) {
	t.Helper()
	var ch model.Chapter
	if err := db.First(&ch, id).Error; err != nil {
		return "", false
	}
	if ch.Content == nil {
		return "", true
	}
	return *ch.Content, true
}

// TestNovelVersionCreateMilestoneCapturesWholeBook proves the bundle really is
// a WHOLE-novel snapshot: every chapter body, the outline acts and the memory
// items all land in one row, decodable from novel_versions.snapshot.
func TestNovelVersionCreateMilestoneCapturesWholeBook(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(201)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章 出山", "负剑出山")
	seedNovelVersionChapter(t, db, userID, novelID, 2, "第二章 雨战", "雨夜初战，血溅三尺")
	seedNovelVersionChapter(t, db, userID, novelID, 3, "第三章 入城", "")

	acts := json.RawMessage(`[{"id":"a1","title":"第一幕","nodes":[{"id":"n1","title":"出山","summary":"s","status":"done"}]},
		{"id":"a2","title":"第二幕","nodes":[]}]`)
	if _, err := s.docSvc.UpdateOutline(ctx, userID, novelID, acts, nil); err != nil {
		t.Fatalf("seed outline: %v", err)
	}
	items := json.RawMessage(`[{"id":"m1","key":"阿绫","value":"青梅"},{"id":"m2","key":"陈默","value":"主角"}]`)
	if _, err := s.docSvc.UpdateMemory(ctx, userID, novelID, items, nil); err != nil {
		t.Fatalf("seed memory: %v", err)
	}

	summary, err := s.CreateMilestone(ctx, userID, novelID, "第一稿完成")
	if err != nil {
		t.Fatalf("CreateMilestone: %v", err)
	}
	if summary.ChapterCount != 3 {
		t.Errorf("ChapterCount = %d, want 3", summary.ChapterCount)
	}
	// 4 + 9 + 0 runes of chapter content.
	if summary.WordCount != 13 {
		t.Errorf("WordCount = %d, want 13", summary.WordCount)
	}
	if summary.Kind != model.VersionKindMilestone {
		t.Errorf("Kind = %q, want %q", summary.Kind, model.VersionKindMilestone)
	}
	if summary.ContentHash == "" {
		t.Error("ContentHash is empty on the returned summary")
	}

	// The stored row must carry the bundle and the same hash.
	var row model.NovelVersion
	if err := db.First(&row, summary.ID).Error; err != nil {
		t.Fatalf("load novel_versions row: %v", err)
	}
	if row.ContentHash != summary.ContentHash {
		t.Errorf("stored ContentHash = %q, want %q", row.ContentHash, summary.ContentHash)
	}
	if len(row.Snapshot) == 0 {
		t.Fatal("stored Snapshot is empty")
	}

	// Assert on the DECODED bundle, not merely on "no error".
	detail, err := s.Get(ctx, userID, summary.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if detail.Snapshot == nil {
		t.Fatal("detail.Snapshot is nil")
	}
	snap := detail.Snapshot
	if len(snap.Chapters) != 3 {
		t.Fatalf("bundle has %d chapters, want 3", len(snap.Chapters))
	}
	want := map[int64]string{1: "负剑出山", 2: "雨夜初战，血溅三尺", 3: ""}
	for _, c := range snap.Chapters {
		if c.Content != want[c.ID] {
			t.Errorf("chapter %d content = %q, want %q", c.ID, c.Content, want[c.ID])
		}
		if c.Title == "" {
			t.Errorf("chapter %d title missing", c.ID)
		}
		if c.SortOrder != c.Position {
			t.Errorf("chapter %d sort_order %d != position %d", c.ID, c.SortOrder, c.Position)
		}
	}
	var gotActs []map[string]any
	if err := json.Unmarshal(snap.Outline.Acts, &gotActs); err != nil {
		t.Fatalf("outline acts not an array: %v", err)
	}
	if len(gotActs) != 2 {
		t.Errorf("bundle has %d outline acts, want 2", len(gotActs))
	}
	var gotItems []map[string]any
	if err := json.Unmarshal(snap.Memory.Items, &gotItems); err != nil {
		t.Fatalf("memory items not an array: %v", err)
	}
	if len(gotItems) != 2 {
		t.Errorf("bundle has %d memory items, want 2", len(gotItems))
	}
}

// TestNovelVersionRestoreDefaultIsConservativeAndCheckpointed is the核心
// safety test: an Agent overwrites a chapter and the outline, the author
// restores the milestone with the DEFAULT (empty) mode, and both come back —
// while a rollback checkpoint of the overwritten state is written first, so
// the restore is itself reversible.
func TestNovelVersionRestoreDefaultIsConservativeAndCheckpointed(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(202)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章", "作者的原文")
	seedNovelVersionChapter(t, db, userID, novelID, 2, "第二章", "第二章原文")

	original := json.RawMessage(`[{"id":"a1","title":"第一幕","nodes":[{"id":"n1","title":"出山","summary":"s","status":"done"}]},
		{"id":"a2","title":"第二幕","nodes":[]}]`)
	if _, err := s.docSvc.UpdateOutline(ctx, userID, novelID, original, nil); err != nil {
		t.Fatalf("seed outline: %v", err)
	}
	before, err := s.docSvc.GetOutline(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}

	ms, err := s.CreateMilestone(ctx, userID, novelID, "Agent 动手前")
	if err != nil {
		t.Fatalf("CreateMilestone: %v", err)
	}

	// --- Agent overwrites the book -------------------------------------
	if err := db.Model(&model.Chapter{}).Where("id = ?", 1).
		Updates(map[string]any{"content": "Agent 生成的正文", "title": "被改写的标题"}).Error; err != nil {
		t.Fatalf("overwrite chapter: %v", err)
	}
	rewritten := json.RawMessage(`[{"id":"z9","title":"Agent 重写的大纲","nodes":[]}]`)
	if _, err := s.docSvc.UpdateOutline(ctx, userID, novelID, rewritten, nil); err != nil {
		t.Fatalf("overwrite outline: %v", err)
	}

	// --- Restore with the default (empty) mode --------------------------
	res, err := s.Restore(ctx, userID, novelID, ms.ID, "")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if res.Mode != RestoreModeConservative {
		t.Errorf("Mode = %q, want %q (empty mode must degrade to conservative)", res.Mode, RestoreModeConservative)
	}
	if res.Updated != 2 || res.Missing != 0 || res.Extra != 0 || res.Created != 0 || res.Deleted != 0 {
		t.Errorf("counts = %+v, want Updated=2 everything else 0", res)
	}

	if got, ok := chapterContentOf(t, db, 1); !ok || got != "作者的原文" {
		t.Errorf("chapter 1 content = %q (ok=%v), want %q", got, ok, "作者的原文")
	}
	var title string
	if err := db.Model(&model.Chapter{}).Where("id = ?", 1).Pluck("title", &title).Error; err != nil {
		t.Fatalf("read title: %v", err)
	}
	if title != "第一章" {
		t.Errorf("chapter 1 title = %q, want %q", title, "第一章")
	}
	after, err := s.docSvc.GetOutline(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline after restore: %v", err)
	}
	if string(after.Acts) != string(before.Acts) {
		t.Errorf("outline not restored:\n got=%s\nwant=%s", after.Acts, before.Acts)
	}

	// --- The pre-restore checkpoint -------------------------------------
	var checkpoints []model.NovelVersion
	if err := db.Where("user_id = ? AND novel_id = ? AND kind = ?", userID, novelID, model.VersionKindRollback).
		Find(&checkpoints).Error; err != nil {
		t.Fatalf("query rollback snapshots: %v", err)
	}
	if len(checkpoints) != 1 {
		t.Fatalf("got %d rollback snapshots, want 1", len(checkpoints))
	}
	cp := checkpoints[0]
	if cp.Label != checkpointLabel {
		t.Errorf("checkpoint label = %q, want %q", cp.Label, checkpointLabel)
	}
	if cp.ID != res.CheckpointID {
		t.Errorf("CheckpointID = %d, want %d", res.CheckpointID, cp.ID)
	}
	// The checkpoint must hold the OVERWRITTEN state, not the snapshot: that
	// is what makes the restore reversible.
	var cpSnap struct {
		Chapters []struct {
			ID      int64  `json:"id"`
			Content string `json:"content"`
		} `json:"chapters"`
	}
	if err := json.Unmarshal(cp.Snapshot, &cpSnap); err != nil {
		t.Fatalf("decode checkpoint snapshot: %v", err)
	}
	found := false
	for _, c := range cpSnap.Chapters {
		if c.ID == 1 && c.Content == "Agent 生成的正文" {
			found = true
		}
	}
	if !found {
		t.Errorf("checkpoint does not hold the pre-restore (overwritten) chapter: %s", cp.Snapshot)
	}
}

// TestNovelVersionRestoreConservativeNeverCreatesOrDeletes is the "do no harm"
// guarantee: a chapter deleted since the snapshot must NOT come back and a
// chapter written since the snapshot must NOT be destroyed — both are only
// counted and reported.
func TestNovelVersionRestoreConservativeNeverCreatesOrDeletes(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(203)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章", "一章")
	seedNovelVersionChapter(t, db, userID, novelID, 2, "第二章", "二章")
	seedNovelVersionChapter(t, db, userID, novelID, 3, "第三章", "三章")

	ms, err := s.CreateMilestone(ctx, userID, novelID, "删除前")
	if err != nil {
		t.Fatalf("CreateMilestone: %v", err)
	}

	if err := s.chapterRepo.Delete(ctx, userID, 2); err != nil {
		t.Fatalf("delete chapter 2: %v", err)
	}
	seedNovelVersionChapter(t, db, userID, novelID, 99, "快照之后新写的一章", "新章")

	res, err := s.Restore(ctx, userID, novelID, ms.ID, "conservative")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if res.Missing != 1 {
		t.Errorf("Missing = %d, want 1", res.Missing)
	}
	if res.Extra != 1 {
		t.Errorf("Extra = %d, want 1", res.Extra)
	}
	if res.Updated != 2 {
		t.Errorf("Updated = %d, want 2", res.Updated)
	}
	if res.Created != 0 || res.Deleted != 0 {
		t.Errorf("conservative restore must not create or delete: Created=%d Deleted=%d", res.Created, res.Deleted)
	}

	// The deleted chapter stays deleted.
	if _, ok := chapterContentOf(t, db, 2); ok {
		t.Error("chapter 2 was recreated by a conservative restore")
	}
	// The chapter written after the snapshot survives untouched.
	if got, ok := chapterContentOf(t, db, 99); !ok || got != "新章" {
		t.Errorf("chapter 99 = %q (ok=%v), want %q — a conservative restore must not delete it", got, ok, "新章")
	}
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("ListByNovelID: %v", err)
	}
	if len(chapters) != 3 {
		t.Errorf("novel has %d chapters after restore, want 3 (1, 3, 99)", len(chapters))
	}
}

// TestNovelVersionRestoreFullRecreatesAndDeletes proves `full` mode reproduces
// the snapshot exactly: the deleted chapter comes back under its ORIGINAL id
// (so outline chapter_id links stay valid) and the chapter written after the
// snapshot is removed.
func TestNovelVersionRestoreFullRecreatesAndDeletes(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(204)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章", "一章")
	seedNovelVersionChapter(t, db, userID, novelID, 2, "第二章", "二章原文")
	seedNovelVersionChapter(t, db, userID, novelID, 3, "第三章", "三章")

	ms, err := s.CreateMilestone(ctx, userID, novelID, "全量还原点")
	if err != nil {
		t.Fatalf("CreateMilestone: %v", err)
	}
	if err := s.chapterRepo.Delete(ctx, userID, 2); err != nil {
		t.Fatalf("delete chapter 2: %v", err)
	}
	seedNovelVersionChapter(t, db, userID, novelID, 99, "快照之后新写的一章", "新章")

	res, err := s.Restore(ctx, userID, novelID, ms.ID, "full")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if res.Mode != RestoreModeFull {
		t.Errorf("Mode = %q, want %q", res.Mode, RestoreModeFull)
	}
	if res.Created != 1 {
		t.Errorf("Created = %d, want 1", res.Created)
	}
	if res.Deleted != 1 {
		t.Errorf("Deleted = %d, want 1", res.Deleted)
	}
	if res.Updated != 2 {
		t.Errorf("Updated = %d, want 2", res.Updated)
	}

	// Recreated under the SAME id.
	var revived model.Chapter
	if err := db.First(&revived, 2).Error; err != nil {
		t.Fatalf("chapter 2 not recreated: %v", err)
	}
	if revived.ID != 2 {
		t.Errorf("recreated chapter id = %d, want 2", revived.ID)
	}
	if revived.Content == nil || *revived.Content != "二章原文" {
		t.Errorf("recreated chapter content = %v, want %q", revived.Content, "二章原文")
	}
	if revived.Title != "第二章" {
		t.Errorf("recreated chapter title = %q, want %q", revived.Title, "第二章")
	}
	if revived.DeletedAt.Valid {
		t.Error("recreated chapter is still soft-deleted")
	}

	// The extra chapter is gone.
	if _, ok := chapterContentOf(t, db, 99); ok {
		t.Error("chapter 99 was not deleted by a full restore")
	}
	chapters, err := s.chapterRepo.ListByNovelID(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("ListByNovelID: %v", err)
	}
	if len(chapters) != 3 {
		t.Errorf("novel has %d chapters after full restore, want 3", len(chapters))
	}
	for _, c := range chapters {
		if c.ID < 1 || c.ID > 3 {
			t.Errorf("unexpected chapter id %d survived a full restore", c.ID)
		}
	}
}

// TestNovelVersionCrossUserAccessIsNotFound is the contract C3 isolation test:
// another user must not be able to list, read or restore the first user's
// whole-novel snapshot — and a rejected restore must not touch any data.
func TestNovelVersionCrossUserAccessIsNotFound(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, otherUser, novelID = int64(1), int64(2), int64(205)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章", "私人正文")

	ms, err := s.CreateMilestone(ctx, userID, novelID, "私人里程碑")
	if err != nil {
		t.Fatalf("CreateMilestone: %v", err)
	}

	if _, err := s.List(ctx, otherUser, novelID, 10, 0); err != ErrNotFound {
		t.Errorf("List(otherUser) error = %v, want ErrNotFound", err)
	}
	if _, err := s.Get(ctx, otherUser, ms.ID); err != ErrNotFound {
		t.Errorf("Get(otherUser) error = %v, want ErrNotFound", err)
	}
	if _, err := s.Restore(ctx, otherUser, novelID, ms.ID, "full"); err != ErrNotFound {
		t.Errorf("Restore(otherUser) error = %v, want ErrNotFound", err)
	}
	if _, err := s.CreateMilestone(ctx, otherUser, novelID, "偷快照"); err != ErrNotFound {
		t.Errorf("CreateMilestone(otherUser) error = %v, want ErrNotFound", err)
	}

	// The owner still sees exactly one snapshot: the rebuffed calls wrote
	// nothing, in particular no rollback checkpoint.
	list, err := s.List(ctx, userID, novelID, 10, 0)
	if err != nil {
		t.Fatalf("List(owner): %v", err)
	}
	if list.Total != 1 {
		t.Errorf("owner Total = %d, want 1 (cross-user calls must not write)", list.Total)
	}
	if got, ok := chapterContentOf(t, db, 1); !ok || got != "私人正文" {
		t.Errorf("chapter 1 = %q (ok=%v), must be untouched", got, ok)
	}
}

// TestNovelDocUpdateOutlineDedupsDuplicateTitleActs is the R1 dedup sink test
// (Phase 3, PART B): a PUT /novels/:id/outline that carries two acts whose
// titles collapse to the SAME outlineTitleKey — "第一幕《神陨之后》" and
// "神陨之后" — must be folded into ONE act, with the second act's node merged
// into the first. This proves the dedup now runs for EVERY outline writer
// (the web panel's PUT as well as the Agent's save_outline), not just one path.
func TestNovelDocUpdateOutlineDedupsDuplicateTitleActs(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(207)
	seedNovel(t, db, userID, novelID)

	dup := json.RawMessage(`[
		{"id":"a1","title":"第一幕《神陨之后》","nodes":[{"id":"n1","title":"出山","summary":"s","status":"done"}]},
		{"id":"a2","title":"神陨之后","nodes":[{"id":"n2","title":"陨落","summary":"s2","status":"planned"}]}
	]`)
	if _, err := s.docSvc.UpdateOutline(ctx, userID, novelID, dup, nil); err != nil {
		t.Fatalf("UpdateOutline: %v", err)
	}

	got, err := s.docSvc.GetOutline(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}
	var acts []map[string]any
	if err := json.Unmarshal(got.Acts, &acts); err != nil {
		t.Fatalf("acts not an array: %v", err)
	}
	if len(acts) != 1 {
		t.Fatalf("expected 1 deduped act, got %d: %s", len(acts), got.Acts)
	}
	nodes, _ := acts[0]["nodes"].([]any)
	if len(nodes) != 2 {
		t.Errorf("expected the two nodes to be merged into the surviving act, got %d: %v", len(nodes), acts[0]["nodes"])
	}
	if title, _ := acts[0]["title"].(string); title != "第一幕《神陨之后》" {
		t.Errorf("surviving act title = %q, want the first act's title", title)
	}
}

// TestNovelVersionContentHashIsStableAndChangesWithContent proves the
// integrity fingerprint behaves: identical state yields an identical hash,
// mutated state a different one — and the hash is actually persisted on the
// row, not only computed in memory.
func TestNovelVersionContentHashIsStableAndChangesWithContent(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelVersionService(t)
	const userID, novelID = int64(1), int64(206)
	seedNovel(t, db, userID, novelID)
	seedNovelVersionChapter(t, db, userID, novelID, 1, "第一章", "稳定正文")

	first, err := s.CreateMilestone(ctx, userID, novelID, "第一次")
	if err != nil {
		t.Fatalf("CreateMilestone (1st): %v", err)
	}
	second, err := s.CreateMilestone(ctx, userID, novelID, "第二次")
	if err != nil {
		t.Fatalf("CreateMilestone (2nd): %v", err)
	}
	if first.ContentHash == "" || second.ContentHash == "" {
		t.Fatal("ContentHash must never be empty")
	}
	if first.ContentHash != second.ContentHash {
		t.Errorf("hash not stable for identical state: %q vs %q", first.ContentHash, second.ContentHash)
	}
	// Always stored when asked: no hash-based skipping.
	if first.ID == second.ID || second.ID == 0 {
		t.Errorf("second milestone was skipped: ids %d / %d", first.ID, second.ID)
	}

	// Persisted on the row.
	var row model.NovelVersion
	if err := db.First(&row, first.ID).Error; err != nil {
		t.Fatalf("load row: %v", err)
	}
	if row.ContentHash != first.ContentHash || len(row.ContentHash) != 16 {
		t.Errorf("stored ContentHash = %q, want %q (16 hex chars)", row.ContentHash, first.ContentHash)
	}

	// Mutating the book changes the hash.
	if err := db.Model(&model.Chapter{}).Where("id = ?", 1).
		Update("content", "被改动的正文").Error; err != nil {
		t.Fatalf("mutate chapter: %v", err)
	}
	third, err := s.CreateMilestone(ctx, userID, novelID, "第三次")
	if err != nil {
		t.Fatalf("CreateMilestone (3rd): %v", err)
	}
	if third.ContentHash == first.ContentHash {
		t.Errorf("hash did not change after a content mutation: %q", third.ContentHash)
	}

	// And the first snapshot still restores the original text.
	if _, err := s.Restore(ctx, userID, novelID, first.ID, "conservative"); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got, ok := chapterContentOf(t, db, 1); !ok || got != "稳定正文" {
		t.Errorf("chapter 1 = %q (ok=%v), want %q", got, ok, "稳定正文")
	}
}
