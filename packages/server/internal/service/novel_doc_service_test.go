package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// ── 回归：act["nodes"] 类型断言 ──────────────────────────────────────────
// json.Unmarshal 到 []map[string]any 时，内层 nodes 是 []interface{} 而非
// []map[string]any。曾经的直接断言静默失败，让 chapterReferenced /
// bindChapterByTitle 把所有节点当成不存在，清理迁移因此误删了全部章节。

func mustParseActs(t *testing.T, raw string) []map[string]any {
	t.Helper()
	acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(raw)))
	if !ok {
		t.Fatalf("parseOutlineActs failed for %s", raw)
	}
	return acts
}

func TestChapterLookupOnJSONParsedActs(t *testing.T) {
	acts := mustParseActs(t, `[{"id":"a1","title":"第一幕","nodes":[
		{"id":"n1","title":"觉醒","status":"planned","chapter_id":7},
		{"id":"n2","title":"第一章 初入人间，百年漫长","status":"planned"}]}]`)

	if !chapterReferenced(acts, 7) {
		t.Fatal("chapterReferenced(7) = false: nodes invisible through wrong type assertion")
	}
	if chapterReferenced(acts, 8) {
		t.Fatal("chapterReferenced(8) = true for unbound chapter")
	}

	// 标题键匹配（去「第一章」序号前缀）在 JSON 解析数据上必须生效。
	ch := model.Chapter{ID: 8, Title: "初入人间，百年漫长", WordCount: 2541}
	if !bindChapterByTitle(acts, ch) {
		t.Fatal("bindChapterByTitle did not match node by title on JSON-parsed acts")
	}
	if !chapterReferenced(acts, 8) {
		t.Fatal("chapter 8 not referenced after bind")
	}

	// appendChapterNode 不得丢掉既有节点。
	acts2 := mustParseActs(t, `[{"id":"a1","title":"第一幕","nodes":[
		{"id":"n1","title":"觉醒","status":"planned"}]}]`)
	acts2 = appendChapterNode(acts2, model.Chapter{ID: 9, Title: "新章"})
	nodes := actNodes(acts2[0])
	if len(nodes) != 2 {
		t.Fatalf("appendChapterNode dropped existing nodes: got %d, want 2", len(nodes))
	}
}

func TestMergeOutlineActOnJSONParsedActs(t *testing.T) {
	// 去重折叠在纯 JSON 解析数据上必须生效（生产路径的真实数据形状）。
	existing := mustParseActs(t, `[{"id":"a1","title":"第一幕","nodes":[
		{"id":"n1","title":"觉醒","status":"planned"}]}]`)
	incoming := mustParseActs(t, `[{"id":"a2","title":"第一幕","nodes":[
		{"id":"n2","title":"觉醒","status":"planned"},
		{"id":"n3","title":"初战","status":"planned"}]}]`)
	if !mergeOutlineAct(existing, incoming[0]) {
		t.Fatal("mergeOutlineAct did not fold same-title act on JSON-parsed data")
	}
	nodes := actNodes(existing[0])
	if len(nodes) != 2 {
		t.Fatalf("folded act has %d nodes, want 2 (duplicate dropped, new appended)", len(nodes))
	}
}

// ── MigrateCleanupOrphanChapters 集成回归 ────────────────────────────────

func newCleanupTestService(t *testing.T) (*NovelDocService, *gorm.DB, context.Context) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "cleanup.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.NovelOutline{}, &model.Chapter{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	svc := NewNovelDocService(
		repository.NewNovelRepository(db),
		repository.NewNovelDocRepository(db),
		repository.NewChapterRepository(db),
		nil,
	)
	return svc, db, context.Background()
}

func seedCleanupFixtures(t *testing.T, db *gorm.DB, ctx context.Context, svc *NovelDocService) {
	t.Helper()
	const (
		userID  = int64(1)
		novelID = int64(100)
	)
	novel := &model.Novel{UserID: userID, Title: "清理测试"}
	novel.ID = novelID
	if err := db.Create(novel).Error; err != nil {
		t.Fatalf("seed novel: %v", err)
	}

	acts := `[{"id":"a1","title":"第一幕","nodes":[
		{"id":"n1","title":"觉醒","status":"drafting","chapter_id":999999},
		{"id":"n2","title":"初入人间，百年漫长","status":"planned"},
		{"id":"n3","title":"已绑定","status":"done","chapter_id":4}]}]`
	if err := db.Create(&model.NovelOutline{
		UserID: userID, NovelID: novelID, Acts: datatypes.JSON(acts),
	}).Error; err != nil {
		t.Fatalf("seed outline: %v", err)
	}

	chapters := []model.Chapter{
		// 真实内容章：标题去序号后匹配 n2 → 应被重绑并保留。
		{ID: 1, UserID: userID, NovelID: novelID, Title: "第一章 初入人间，百年漫长", WordCount: 2541, Status: "draft", Position: 0},
		// 旧文章库孤儿：无节点匹配 → 应被删除。
		{ID: 2, UserID: userID, NovelID: novelID, Title: "孤儿旧文章", WordCount: 100, Status: "draft", Position: 1},
		// 空壳章：幽灵绑定修复后匹配 n1 → 应被重绑并保留。
		{ID: 3, UserID: userID, NovelID: novelID, Title: "觉醒", WordCount: 0, Status: "draft", Position: 2},
		// 已正常绑定的章 → 必须原样保留。
		{ID: 4, UserID: userID, NovelID: novelID, Title: "已绑定", WordCount: 500, Status: "done", Position: 3},
	}
	for i := range chapters {
		if err := db.Create(&chapters[i]).Error; err != nil {
			t.Fatalf("seed chapter %d: %v", chapters[i].ID, err)
		}
	}
}

func TestMigrateCleanupOrphanChapters(t *testing.T) {
	svc, db, ctx := newCleanupTestService(t)
	seedCleanupFixtures(t, db, ctx, svc)

	deleted, err := svc.MigrateCleanupOrphanChapters(ctx)
	if err != nil {
		t.Fatalf("cleanup returned error: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1 (only the unmatchable orphan)", deleted)
	}

	// 幽灵绑定（999999 不存在）被清除后按标题重绑到真实章节；已绑定章保留。
	var outline model.NovelOutline
	if err := db.Where("novel_id = ?", int64(100)).First(&outline).Error; err != nil {
		t.Fatalf("load outline: %v", err)
	}
	acts := mustParseActs(t, string(outline.Acts))
	nodes := actNodes(acts[0])
	bound := map[string]float64{}
	for _, n := range nodes {
		if id, ok := n["chapter_id"].(float64); ok {
			bound[n["title"].(string)] = id
		}
	}
	if bound["觉醒"] != 3 {
		t.Errorf("node 觉醒 bound to %v, want 3 (phantom 999999 repaired → rebind)", bound["觉醒"])
	}
	if bound["初入人间，百年漫长"] != 1 {
		t.Errorf("node 初入人间 bound to %v, want 1 (title rebind)", bound["初入人间，百年漫长"])
	}
	if bound["已绑定"] != 4 {
		t.Errorf("node 已绑定 bound to %v, want 4 (untouched)", bound["已绑定"])
	}

	// 章节存活与删除。
	var live []model.Chapter
	if err := db.Where("deleted_at IS NULL").Find(&live).Error; err != nil {
		t.Fatalf("list chapters: %v", err)
	}
	if len(live) != 3 {
		t.Fatalf("live chapters = %d, want 3", len(live))
	}

	// 字数重算：只统计保留章节（2541 + 0 + 500）。
	var novel model.Novel
	if err := db.First(&novel, int64(100)).Error; err != nil {
		t.Fatalf("load novel: %v", err)
	}
	if novel.WordCount != 3041 {
		t.Errorf("novel word_count = %d, want 3041 (deprecated data excluded)", novel.WordCount)
	}

	// 幂等：重跑不再删除任何章节。
	if again, err := svc.MigrateCleanupOrphanChapters(ctx); err != nil || again != 0 {
		t.Errorf("second run deleted %d chapters (err=%v), want 0 (idempotent)", again, err)
	}
}

// 空大纲（无节点）与无大纲行的小说：全部章节都是孤儿，全部删除。
func TestMigrateCleanupOrphanChaptersEmptyOutline(t *testing.T) {
	svc, db, ctx := newCleanupTestService(t)

	for _, id := range []int64{200, 201} {
		if err := db.Create(&model.Novel{ID: id, UserID: 1, Title: "空大纲"}).Error; err != nil {
			t.Fatalf("seed novel %d: %v", id, err)
		}
	}
	chapters := []model.Chapter{
		{ID: 11, UserID: 1, NovelID: 200, Title: "孤儿甲", WordCount: 30, Position: 0}, // 大纲 acts=[] → 孤儿
		{ID: 12, UserID: 1, NovelID: 201, Title: "孤儿乙", WordCount: 40, Position: 0}, // 无大纲行 → 孤儿
	}
	for i := range chapters {
		if err := db.Create(&chapters[i]).Error; err != nil {
			t.Fatalf("seed chapter %d: %v", chapters[i].ID, err)
		}
	}
	// novel 200 有一个空 acts 文档。
	if err := db.Create(&model.NovelOutline{
		UserID: 1, NovelID: 200, Acts: datatypes.JSON(`[]`),
	}).Error; err != nil {
		t.Fatalf("seed empty outline: %v", err)
	}

	deleted, err := svc.MigrateCleanupOrphanChapters(ctx)
	if err != nil {
		t.Fatalf("cleanup returned error: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("deleted = %d, want 2 (chapters under empty/absent outlines are all orphans)", deleted)
	}
	var live int64
	if err := db.Model(&model.Chapter{}).Where("deleted_at IS NULL").Count(&live).Error; err != nil {
		t.Fatalf("count live: %v", err)
	}
	if live != 0 {
		t.Errorf("live chapters = %d, want 0", live)
	}
	var novel model.Novel
	if err := db.First(&novel, int64(200)).Error; err != nil {
		t.Fatalf("load novel: %v", err)
	}
	if novel.WordCount != 0 {
		t.Errorf("novel 200 word_count = %d, want 0", novel.WordCount)
	}
}
