package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// newTestOutlineAgent builds an AgentService whose document store is backed by
// an on-disk-free SQLite database. syncOutline only touches docSvc, so every
// other collaborator is left nil.
//
// SQLite also proves the C11 dual-mode constraint: Acts is datatypes.JSON,
// which is jsonb on PostgreSQL and text on SQLite, and the normalization code
// is pure Go — it never issues engine-specific SQL.
func newTestOutlineAgent(t *testing.T) (*AgentService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "outline.db") + "?cache=shared"
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
	if err := db.AutoMigrate(&model.Novel{}, &model.NovelOutline{}, &model.OutlineVersion{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	novelRepo := repository.NewNovelRepository(db)
	docRepo := repository.NewNovelDocRepository(db)
	docSvc := NewNovelDocService(novelRepo, docRepo, nil, repository.NewOutlineVersionRepository(db))
	agent := NewAgentService(nil, nil, docSvc, nil, "http://127.0.0.1:1", zap.NewNop())
	return agent, db
}

// seedNovel inserts a novel owned by userID so the doc service's ownership
// check (C3 user isolation) passes.
func seedNovel(t *testing.T, db *gorm.DB, userID, novelID int64) {
	t.Helper()
	novel := &model.Novel{UserID: userID, Title: "测试作品"}
	novel.ID = novelID
	if err := db.Create(novel).Error; err != nil {
		t.Fatalf("seed novel: %v", err)
	}
}

// assertContractCompliant enforces the invariant the web outline panel depends
// on: every act carries a non-empty id and an array nodes field, and every node
// carries a non-empty id and one of the three legal statuses.
func assertContractCompliant(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var acts []map[string]any
	if err := json.Unmarshal(raw, &acts); err != nil {
		t.Fatalf("stored acts is not a JSON array: %v", err)
	}
	for i, a := range acts {
		if id, _ := a["id"].(string); id == "" {
			t.Errorf("act[%d] has no id", i)
		}
		if _, ok := a["title"].(string); !ok {
			t.Errorf("act[%d] title is not a string", i)
		}
		nodes, ok := a["nodes"].([]any)
		if !ok {
			t.Fatalf("act[%d] nodes is %T, want array", i, a["nodes"])
		}
		for j, n := range nodes {
			node, ok := n.(map[string]any)
			if !ok {
				t.Fatalf("act[%d].nodes[%d] is %T, want object", i, j, n)
			}
			if id, _ := node["id"].(string); id == "" {
				t.Errorf("act[%d].nodes[%d] has no id", i, j)
			}
			if st, _ := node["status"].(string); !isOutlineStatus(st) {
				t.Errorf("act[%d].nodes[%d] illegal status %q", i, j, st)
			}
			if _, ok := node["title"].(string); !ok {
				t.Errorf("act[%d].nodes[%d] title is not a string", i, j)
			}
			if _, ok := node["summary"].(string); !ok {
				t.Errorf("act[%d].nodes[%d] summary is not a string", i, j)
			}
		}
	}
}

// TestSyncOutlineWritesNormalizedActs is the regression test for the crash:
// the Agent's save_outline used to append the LLM's raw act maps verbatim, so
// acts arrived without ids and without a nodes array and the web panel threw a
// TypeError on render. This feeds the exact dirty shapes observed in production
// and asserts what actually lands in novel_outline.
func TestSyncOutlineWritesNormalizedActs(t *testing.T) {
	agent, db := newTestOutlineAgent(t)
	const userID, novelID = int64(1), int64(33)
	seedNovel(t, db, userID, novelID)

	rawActs := []interface{}{
		// no id, nodes present but nodes lack id/status — novel 33/34 shape
		map[string]any{
			"title": "第一幕：出山",
			"nodes": []interface{}{
				map[string]any{"title": "负剑出山", "summary": "<p>陈默离开师门</p>"},
				map[string]any{"title": "雨夜初战", "summary": "初露锋芒", "status": "bogus"},
			},
		},
		// no id, no nodes at all — novel 20/21 shape
		map[string]any{"title": "第二幕"},
		// nodes is not an array
		map[string]any{"title": "第三幕", "nodes": "oops"},
		// unusable entries must be dropped, not stored
		map[string]any{"nodes": []interface{}{}},
		"not-an-object",
	}

	saved, err := agent.syncOutline(context.Background(), userID, novelID, rawActs)
	if err != nil {
		t.Fatalf("syncOutline: %v", err)
	}
	if saved != 3 {
		t.Fatalf("saved = %d, want 3 (2 unusable entries dropped)", saved)
	}

	doc, err := agent.docSvc.GetOutline(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}
	assertContractCompliant(t, doc.Acts)

	var acts []map[string]any
	_ = json.Unmarshal(doc.Acts, &acts)
	if len(acts) != 3 {
		t.Fatalf("stored %d acts, want 3: %s", len(acts), doc.Acts)
	}
	// nodes:"oops" must have become [].
	if n, ok := acts[2]["nodes"].([]any); !ok || len(n) != 0 {
		t.Errorf("act 2 nodes should be [], got %#v", acts[2]["nodes"])
	}
	// illegal status must have fallen back to planned.
	st := acts[0]["nodes"].([]any)[1].(map[string]any)["status"]
	if st != "planned" {
		t.Errorf("illegal status should become planned, got %v", st)
	}
	// HTML summary must not be escaped.
	sum := acts[0]["nodes"].([]any)[0].(map[string]any)["summary"]
	if sum != "<p>陈默离开师门</p>" {
		t.Errorf("summary mutated: %q", sum)
	}
}

// TestSyncOutlineIsIdempotentAndPreservesExisting guards the merge strategy:
// re-running save_outline with the same act title must not create a twin act,
// and pre-existing acts must survive untouched.
func TestSyncOutlineIsIdempotentAndPreservesExisting(t *testing.T) {
	agent, db := newTestOutlineAgent(t)
	const userID, novelID = int64(1), int64(34)
	seedNovel(t, db, userID, novelID)

	// Pre-existing user-authored act, with a node that has a chapter link.
	existing := json.RawMessage(`[{"id":"a1","title":"第 1 幕","nodes":[
		{"id":"n1","title":"第一章","summary":"s","status":"done","chapter_id":42,"memory_refs":["阿绫"]}
	]}]`)
	if _, err := agent.docSvc.UpdateOutline(context.Background(), userID, novelID, existing, nil); err != nil {
		t.Fatalf("seed outline: %v", err)
	}

	incoming := []interface{}{
		map[string]any{
			"title": "第 1 幕", // same title → merge into a1
			"nodes": []interface{}{
				map[string]any{"title": "第一章", "summary": "s"}, // duplicate title → skipped
				map[string]any{"title": "第二章", "summary": "s2"},
			},
		},
		map[string]any{"title": "第 2 幕", "nodes": []interface{}{}}, // new act → appended
	}

	for run := 0; run < 2; run++ {
		if _, err := agent.syncOutline(context.Background(), userID, novelID, incoming); err != nil {
			t.Fatalf("syncOutline run %d: %v", run, err)
		}
	}

	doc, err := agent.docSvc.GetOutline(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}
	assertContractCompliant(t, doc.Acts)

	var acts []map[string]any
	_ = json.Unmarshal(doc.Acts, &acts)
	// Two runs of the same payload must not duplicate acts or nodes.
	if len(acts) != 2 {
		t.Fatalf("stored %d acts, want 2 (idempotent): %s", len(acts), doc.Acts)
	}
	nodes := acts[0]["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("act 0 has %d nodes, want 2 (duplicate skipped): %s", len(nodes), doc.Acts)
	}
	// The pre-existing node (with its chapter link) must be preserved as-is.
	first := nodes[0].(map[string]any)
	if first["id"] != "n1" || first["status"] != "done" {
		t.Errorf("pre-existing node mutated: %#v", first)
	}
	if v, _ := first["chapter_id"].(float64); v != 42 {
		t.Errorf("chapter_id lost: %#v", first["chapter_id"])
	}
}

// TestSyncOutlineRepairsLegacyRowOnWrite covers the self-healing path: a row
// written by an unpatched Agent build is repaired the next time the Agent saves.
func TestSyncOutlineRepairsLegacyRowOnWrite(t *testing.T) {
	agent, db := newTestOutlineAgent(t)
	const userID, novelID = int64(1), int64(35)
	seedNovel(t, db, userID, novelID)

	legacy := json.RawMessage(`[{"title":"B"},{"nodes":[{"title":"x","summary":"y"}],"title":"第一幕"}]`)
	if _, err := agent.docSvc.UpdateOutline(context.Background(), userID, novelID, legacy, nil); err != nil {
		t.Fatalf("seed legacy outline: %v", err)
	}

	if _, err := agent.syncOutline(context.Background(), userID, novelID, []interface{}{
		map[string]any{"title": "新的幕", "nodes": []interface{}{}},
	}); err != nil {
		t.Fatalf("syncOutline: %v", err)
	}

	doc, err := agent.docSvc.GetOutline(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}
	assertContractCompliant(t, doc.Acts)

	var acts []map[string]any
	_ = json.Unmarshal(doc.Acts, &acts)
	if len(acts) != 3 {
		t.Fatalf("stored %d acts, want 3 (legacy rows kept + repaired): %s", len(acts), doc.Acts)
	}
}

// TestSyncOutlineNoWriteWhenNothingUsable keeps the original early-return
// semantics: an all-garbage payload must not bump the document version.
func TestSyncOutlineNoWriteWhenNothingUsable(t *testing.T) {
	agent, db := newTestOutlineAgent(t)
	const userID, novelID = int64(1), int64(36)
	seedNovel(t, db, userID, novelID)

	before, err := agent.docSvc.GetOutline(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}

	saved, err := agent.syncOutline(context.Background(), userID, novelID, []interface{}{
		map[string]any{"title": "   "},
		"garbage",
		42,
	})
	if err != nil {
		t.Fatalf("syncOutline: %v", err)
	}
	if saved != 0 {
		t.Fatalf("saved = %d, want 0", saved)
	}

	after, err := agent.docSvc.GetOutline(context.Background(), userID, novelID)
	if err != nil {
		t.Fatalf("GetOutline: %v", err)
	}
	if after.Version != before.Version {
		t.Errorf("version bumped from %d to %d on a no-op", before.Version, after.Version)
	}
}
