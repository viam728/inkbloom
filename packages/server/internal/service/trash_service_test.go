package service

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// 垃圾桶闭环：删除要点（章节+节点+正文一起进桶）→ 列表 → 重选幕恢复 → 彻底删除。
func TestTrashNodeRestorePurge(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "trash.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.NovelOutline{}, &model.Chapter{}, &model.ChapterTrash{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	const (
		uid   = int64(1)
		nid   = int64(50)
		chA   = int64(61)
		chB   = int64(62)
		chPos = int64(63)
	)
	if err := db.Create(&model.Novel{ID: nid, UserID: uid, Title: "垃圾桶测试"}).Error; err != nil {
		t.Fatalf("seed novel: %v", err)
	}
	acts := `[{"id":"act-1","title":"第一幕","nodes":[
		{"id":"nd-a","title":"审判之后","status":"drafting","chapter_id":61,"summary":"<p>结案</p>"},
		{"id":"nd-b","title":"白淞镇的清晨","status":"drafting","chapter_id":62},
		{"id":"nd-pos","title":"占位要点","status":"planned","chapter_id":63}],
		"summary":""},{"id":"act-2","title":"第二幕","nodes":[]}]`
	if err := db.Create(&model.NovelOutline{UserID: uid, NovelID: nid, Acts: datatypes.JSON(acts)}).Error; err != nil {
		t.Fatalf("seed outline: %v", err)
	}
	contentA := "审判落幕，芙宁娜走出歌剧院。"
	seedCh := []model.Chapter{
		{ID: chA, UserID: uid, NovelID: nid, Title: "审判之后", Content: &contentA, WordCount: 15, Status: "draft", Position: 0},
		{ID: chB, UserID: uid, NovelID: nid, Title: "白淞镇的清晨", WordCount: 0, Status: "draft", Position: 1},
		{ID: chPos, UserID: uid, NovelID: nid, Title: "占位", WordCount: 0, Status: "draft", Position: 2},
	}
	for i := range seedCh {
		if err := db.Create(&seedCh[i]).Error; err != nil {
			t.Fatalf("seed chapter: %v", err)
		}
	}

	svc := NewTrashService(db, repository.NewNovelRepository(db))
	ctx := context.Background()

	// ① 删除要点 nd-a：节点摘除 + 章节 61 软删 + 入桶。
	if _, err := svc.TrashNode(ctx, uid, nid, "act-1", "nd-a"); err != nil {
		t.Fatalf("TrashNode: %v", err)
	}
	var chArow model.Chapter
	if err := db.Unscoped().First(&chArow, chA).Error; err != nil {
		t.Fatalf("load ch61: %v", err)
	}
	if !chArow.DeletedAt.Valid {
		t.Fatal("chapter 61 should be soft-deleted after trash")
	}
	var outline model.NovelOutline
	if err := db.First(&outline, map[string]any{"novel_id": nid}).Error; err != nil {
		t.Fatalf("load outline: %v", err)
	}
	parsed := mustParseActs(t, string(outline.Acts))
	if n := len(actNodes(parsed[0])); n != 2 {
		t.Fatalf("act-1 nodes = %d, want 2 (node removed)", n)
	}
	if outline.Version == 0 {
		t.Fatal("outline version should bump on trash")
	}

	// 列表可查，含正文快照与原幕信息。
	items, err := svc.List(ctx, uid, nid)
	if err != nil || len(items) != 1 {
		t.Fatalf("List = %v (%d items), want 1", err, len(items))
	}
	if items[0].ActTitle != "第一幕" || items[0].ChapterID != chA {
		t.Fatalf("list item mismatch: %+v", items[0])
	}

	// ② 恢复到第二幕：节点插回 + 章节 61 复活（原 position 0 仍空闲 → 保持）。
	if err := svc.Restore(ctx, uid, nid, items[0].ID, "act-2"); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if err := db.First(&chArow, chA).Error; err != nil {
		t.Fatalf("chapter 61 not restored: %v", err)
	}
	if chArow.Content == nil || *chArow.Content != contentA {
		t.Fatal("chapter content lost on restore")
	}
	if err := db.First(&outline, map[string]any{"novel_id": nid}).Error; err != nil {
		t.Fatalf("reload outline: %v", err)
	}
	parsed = mustParseActs(t, string(outline.Acts))
	nodes2 := actNodes(parsed[1])
	if len(nodes2) != 1 || nodes2[0]["id"] != "nd-a" {
		t.Fatalf("act-2 should contain restored node, got %v", nodes2)
	}
	if id, _ := nodes2[0]["chapter_id"].(float64); int64(id) != chA {
		t.Fatalf("restored node binding = %v, want %d", nodes2[0]["chapter_id"], chA)
	}
	items, _ = svc.List(ctx, uid, nid)
	if len(items) != 0 {
		t.Fatalf("trash should be empty after restore, got %d", len(items))
	}

	// ③ position 冲突回退：把章节 62 删除占住 position 1，再恢复 62 → position 回退到末尾。
	if _, err := svc.TrashNode(ctx, uid, nid, "act-1", "nd-b"); err != nil {
		t.Fatalf("TrashNode(nd-b): %v", err)
	}
	db.Model(&model.Chapter{}).Where("id = ?", chPos).Update("position", 1) // 占住 position 1
	items, _ = svc.List(ctx, uid, nid)
	if err := svc.Restore(ctx, uid, nid, items[0].ID, "act-1"); err != nil {
		t.Fatalf("Restore(nd-b) with position conflict: %v", err)
	}
	var chBrow model.Chapter
	if err := db.First(&chBrow, chB).Error; err != nil {
		t.Fatalf("chapter 62 not restored: %v", err)
	}
	if chBrow.Position == 1 {
		t.Fatal("restored chapter kept conflicted position 1")
	}

	// ④ 彻底删除：章节行物理删除 + 记录出桶。
	if _, err := svc.TrashNode(ctx, uid, nid, "act-1", "nd-pos"); err != nil {
		t.Fatalf("TrashNode(nd-pos): %v", err)
	}
	items, _ = svc.List(ctx, uid, nid)
	if err := svc.Purge(ctx, uid, nid, items[0].ID); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	var cnt int64
	db.Model(&model.Chapter{}).Unscoped().Where("id = ?", chPos).Count(&cnt)
	if cnt != 0 {
		t.Fatal("purged chapter row should be gone")
	}
	items, _ = svc.List(ctx, uid, nid)
	if len(items) != 0 {
		t.Fatalf("trash should be empty after purge, got %d", len(items))
	}
}
