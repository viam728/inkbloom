package service

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/gorm"
)

// newTestAgentContextService builds an AgentContextService whose stores are
// backed by an on-disk SQLite database so the novel description assembly path
// runs against real repositories.
func newTestAgentContextService(t *testing.T) (*AgentContextService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "agentctx.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.NovelOutline{}, &model.NovelMemory{}, &model.Chapter{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	return NewAgentContextService(
		repository.NewNovelRepository(db),
		repository.NewNovelDocRepository(db),
		repository.NewChapterRepository(db),
	), db
}

func TestBuildAgentContextCarriesNovelDescription(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(200)
	desc := "一个关于剑客的故事"
	seedNovelWithDescription(t, db, userID, novelID, &desc)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章", nil)
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	if payload.Context.NovelDescription != desc {
		t.Errorf("NovelDescription = %q, want %q", payload.Context.NovelDescription, desc)
	}
}

func TestBuildAgentContextEmptyDescriptionDegrades(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(201)
	seedNovel(t, db, userID, novelID)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章", nil)
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	if payload.Context.NovelDescription != "" {
		t.Errorf("NovelDescription = %q, want empty string", payload.Context.NovelDescription)
	}
}

func TestBuildAgentContextTruncatesOverlongDescription(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(202)
	long := strings.Repeat("字", 900)
	seedNovelWithDescription(t, db, userID, novelID, &long)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章", nil)
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	got := payload.Context.NovelDescription
	if n := len([]rune(got)); n != descriptionContextBudget {
		t.Errorf("truncated length = %d runes, want %d", n, descriptionContextBudget)
	}
	if !strings.HasPrefix(long, got) {
		t.Errorf("description is not a prefix-preserving truncation")
	}
}

// boolPtr is a helper for legacy-field test cases.
func boolPtr(b bool) *bool { return &b }

// TestResolveMemoryItemsSixGates covers the six-mode AI access gates
// (备忘录：3 软闸 + 3 硬闸) at a fixed writing position, plus the fail-closed
// semantics (no writing position / missing parameters) and the legacy
// chapter-lock field migration.
func TestResolveMemoryItemsSixGates(t *testing.T) {
	// Outline positions: n1=第1章, n2=第2章, n3=第3章.
	pos := map[string]int{"n1": 1, "n2": 2, "n3": 3}
	title := map[string]string{"n1": "第一章", "n2": "第二章", "n3": "第三章"}

	atN1 := "n1" // 第1章（解锁章之前）
	atN2 := "n2" // 解锁章
	atN3 := "n3" // 解锁章之后

	cases := []struct {
		name       string
		item       agentMemoryItem
		targetNode string
		wantIn     bool   // 是否进注入列表
		wantVis    string // "visible" | "ignore" | "hidden"
		wantNote   bool   // 是否附带约束说明
	}{
		// ── 无闸门 ──
		{"no gate injects unrestricted", agentMemoryItem{ID: "m0", Name: "无限制"}, atN2, true, "visible", false},

		// ── 硬闸 ──
		{"hard disabled never injects", agentMemoryItem{ID: "m1", Name: "全局禁用", AIAccess: &agentMemoryAccess{Mode: accessDisabled}}, atN2, false, "", false},
		{"hard restricted before unlock drops", agentMemoryItem{ID: "m2", Name: "限制禁用", AIAccess: &agentMemoryAccess{Mode: accessRestrictedDisabled, UnlockChapterID: "n2"}}, atN1, false, "", false},
		{"hard restricted at unlock injects", agentMemoryItem{ID: "m2", Name: "限制禁用", AIAccess: &agentMemoryAccess{Mode: accessRestrictedDisabled, UnlockChapterID: "n2"}}, atN2, true, "visible", false},
		{"hard restricted after unlock injects", agentMemoryItem{ID: "m2", Name: "限制禁用", AIAccess: &agentMemoryAccess{Mode: accessRestrictedDisabled, UnlockChapterID: "n2"}}, atN3, true, "visible", false},
		{"hard partial outside set drops", agentMemoryItem{ID: "m3", Name: "局部禁用", AIAccess: &agentMemoryAccess{Mode: accessPartialDisabled, VisibleChapterIDs: []string{"n1", "n3"}}}, atN2, false, "", false},
		{"hard partial inside set injects", agentMemoryItem{ID: "m3", Name: "局部禁用", AIAccess: &agentMemoryAccess{Mode: accessPartialDisabled, VisibleChapterIDs: []string{"n1", "n3"}}}, atN3, true, "visible", false},

		// ── 软闸 ──
		{"soft ignore injects with directive", agentMemoryItem{ID: "m4", Name: "全局忽略", AIAccess: &agentMemoryAccess{Mode: accessIgnore}}, atN2, true, "ignore", true},
		{"soft restricted before unlock hidden", agentMemoryItem{ID: "m5", Name: "限制可见", AIAccess: &agentMemoryAccess{Mode: accessRestrictedVisible, UnlockChapterID: "n2"}}, atN1, true, "hidden", true},
		{"soft restricted at unlock visible", agentMemoryItem{ID: "m5", Name: "限制可见", AIAccess: &agentMemoryAccess{Mode: accessRestrictedVisible, UnlockChapterID: "n2"}}, atN2, true, "visible", false},
		{"soft partial outside set hidden", agentMemoryItem{ID: "m6", Name: "局部可见", AIAccess: &agentMemoryAccess{Mode: accessPartialVisible, VisibleChapterIDs: []string{"n3"}}}, atN1, true, "hidden", true},
		{"soft partial inside set visible", agentMemoryItem{ID: "m6", Name: "局部可见", AIAccess: &agentMemoryAccess{Mode: accessPartialVisible, VisibleChapterIDs: []string{"n3"}}}, atN3, true, "visible", false},

		// ── fail-closed：无写作位置（大纲生成/纯聊天）──
		{"no target drops hard gates", agentMemoryItem{ID: "m7", Name: "限制禁用", AIAccess: &agentMemoryAccess{Mode: accessRestrictedDisabled, UnlockChapterID: "n2"}}, "", false, "", false},
		{"no target hides soft gates", agentMemoryItem{ID: "m8", Name: "限制可见", AIAccess: &agentMemoryAccess{Mode: accessRestrictedVisible, UnlockChapterID: "n2"}}, "", true, "hidden", true},
		{"no target keeps plain items", agentMemoryItem{ID: "m9", Name: "无限制"}, "", true, "visible", false},

		// ── fail-closed：闸门参数缺失 ──
		{"missing unlock id drops hard gate", agentMemoryItem{ID: "m10", Name: "限制禁用", AIAccess: &agentMemoryAccess{Mode: accessRestrictedDisabled, UnlockChapterID: "ghost"}}, atN3, false, "", false},
		{"missing unlock id hides soft gate", agentMemoryItem{ID: "m11", Name: "限制可见", AIAccess: &agentMemoryAccess{Mode: accessRestrictedVisible, UnlockChapterID: "ghost"}}, atN3, true, "hidden", true},
		{"empty partial set drops hard gate", agentMemoryItem{ID: "m12", Name: "局部禁用", AIAccess: &agentMemoryAccess{Mode: accessPartialDisabled, VisibleChapterIDs: nil}}, atN3, false, "", false},
		{"empty partial set hides soft gate", agentMemoryItem{ID: "m13", Name: "局部可见", AIAccess: &agentMemoryAccess{Mode: accessPartialVisible, VisibleChapterIDs: nil}}, atN3, true, "hidden", true},

		// ── 旧字段迁移（effectiveAccess）──
		{"legacy ai_visible=false maps to disabled", agentMemoryItem{ID: "m14", Name: "旧AI不可见", AIVisible: boolPtr(false)}, atN2, false, "", false},
		{"legacy visible_chapters maps to partial_visible", agentMemoryItem{ID: "m15", Name: "旧章节锁", VisibleChapters: []string{"n3"}}, atN2, true, "hidden", true},
		{"legacy visible_chapters honored at position", agentMemoryItem{ID: "m15", Name: "旧章节锁", VisibleChapters: []string{"n3"}}, atN3, true, "visible", false},
		{"ai_access wins over legacy fields", agentMemoryItem{ID: "m16", Name: "新闸门优先", AIVisible: boolPtr(false), AIAccess: &agentMemoryAccess{Mode: accessIgnore}}, atN2, true, "ignore", true},

		// ── 未知模式容错 ──
		{"unknown mode tolerated as visible", agentMemoryItem{ID: "m17", Name: "未知模式", AIAccess: &agentMemoryAccess{Mode: "future_mode"}}, atN2, true, "visible", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolved := resolveMemoryItems([]agentMemoryItem{tc.item}, tc.targetNode, pos, title)
			if tc.wantIn {
				if len(resolved) != 1 {
					t.Fatalf("item not injected, want 1 resolved, got %d", len(resolved))
				}
				r := resolved[0]
				if r.visibility != tc.wantVis {
					t.Errorf("visibility = %q, want %q", r.visibility, tc.wantVis)
				}
				if tc.wantNote && r.note == "" {
					t.Errorf("expected non-empty directive note")
				}
				if !tc.wantNote && r.note != "" {
					t.Errorf("unexpected note: %q", r.note)
				}
			} else if len(resolved) != 0 {
				t.Fatalf("item should be dropped, got %d resolved", len(resolved))
			}
		})
	}
}

// TestMemoryAccessRules covers the centralized 记忆访问规则 text composition.
func TestMemoryAccessRules(t *testing.T) {
	plain := []resolvedMemoryItem{{item: agentMemoryItem{Name: "a"}, visibility: "visible"}}
	if got := memoryAccessRules(plain); got != "" {
		t.Errorf("no soft gates → rules must be empty, got %q", got)
	}
	ignoreOnly := []resolvedMemoryItem{{item: agentMemoryItem{Name: "a"}, visibility: "ignore", note: "x"}}
	if got := memoryAccessRules(ignoreOnly); !strings.Contains(got, "忽略") || strings.Contains(got, "剧透") {
		t.Errorf("ignore-only rules mismatch: %q", got)
	}
	hiddenOnly := []resolvedMemoryItem{{item: agentMemoryItem{Name: "b"}, visibility: "hidden", note: "y"}}
	if got := memoryAccessRules(hiddenOnly); !strings.Contains(got, "剧透") || !strings.Contains(got, "伏笔") {
		t.Errorf("hidden-only rules mismatch: %q", got)
	}
	both := []resolvedMemoryItem{
		{item: agentMemoryItem{Name: "a"}, visibility: "ignore", note: "x"},
		{item: agentMemoryItem{Name: "b"}, visibility: "hidden", note: "y"},
	}
	got := memoryAccessRules(both)
	if !strings.Contains(got, "忽略") || !strings.Contains(got, "剧透") {
		t.Errorf("combined rules mismatch: %q", got)
	}
}
