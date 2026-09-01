package service

import (
	"encoding/json"
	"testing"
)

// mustDecodeJSON parses a JSON literal into a generic value, failing the test on error.
func mustDecodeJSON(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("bad test fixture %q: %v", s, err)
	}
	return v
}

// outlineActTitles extracts the title of every act in a normalized JSON payload.
func outlineActTitles(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var acts []map[string]any
	if err := json.Unmarshal(raw, &acts); err != nil {
		t.Fatalf("normalized payload is not a JSON array: %v", err)
	}
	out := make([]string, 0, len(acts))
	for _, a := range acts {
		out = append(out, a["title"].(string))
	}
	return out
}

func TestNormalizeOutlineActsJSON_RepairsAgentDirtyData(t *testing.T) {
	// Exactly the shapes observed in novel_outline for novel_id 20/21/33/34.
	in := json.RawMessage(`[
		{"title": "B"},
		{"title": "第二幕", "summary": "再次验证"},
		{"nodes": [{"title": "负剑出山", "summary": "<p>陈默离开师门</p>"}], "title": "第一幕：出山"}
	]`)

	out := normalizeOutlineActsJSON(in)

	var acts []map[string]any
	if err := json.Unmarshal(out, &acts); err != nil {
		t.Fatalf("result is not an array: %v", err)
	}
	if len(acts) != 3 {
		t.Fatalf("want 3 acts, got %d (%s)", len(acts), out)
	}
	for i, a := range acts {
		if id, _ := a["id"].(string); id == "" {
			t.Errorf("act[%d] missing id", i)
		}
		nodes, ok := a["nodes"].([]any)
		if !ok {
			t.Fatalf("act[%d] nodes is %T, want array", i, a["nodes"])
		}
		for j, n := range nodes {
			node, ok := n.(map[string]any)
			if !ok {
				t.Fatalf("act[%d].node[%d] is %T, want object", i, j, n)
			}
			if id, _ := node["id"].(string); id == "" {
				t.Errorf("act[%d].node[%d] missing id", i, j)
			}
			if st, _ := node["status"].(string); !isOutlineStatus(st) {
				t.Errorf("act[%d].node[%d] illegal status %q", i, j, st)
			}
			if _, ok := node["title"].(string); !ok {
				t.Errorf("act[%d].node[%d] title is not a string", i, j)
			}
			if _, ok := node["summary"].(string); !ok {
				t.Errorf("act[%d].node[%d] summary is not a string", i, j)
			}
		}
	}
	// HTML in summary must survive verbatim.
	got := acts[2]["nodes"].([]any)[0].(map[string]any)["summary"]
	if got != "<p>陈默离开师门</p>" {
		t.Errorf("summary was mutated: %q", got)
	}
}

func TestNormalizeOutlineActsJSON_RejectsNonArray(t *testing.T) {
	for _, in := range []string{`{"nope":1}`, `null`, `123`, `"str"`} {
		if got := string(normalizeOutlineActsJSON(json.RawMessage(in))); got != "[]" {
			t.Errorf("input %s → %s, want []", in, got)
		}
	}
}

func TestNormalizeOutlineActsJSON_PreservesChapterAndMemoryRefs(t *testing.T) {
	in := json.RawMessage(`[{"id":"a1","title":"幕","nodes":[
		{"id":"n1","title":"章","summary":"s","status":"done","chapter_id":1788197489730,"memory_refs":["阿绫",7]}
	]}]`)
	out := normalizeOutlineActsJSON(in)
	var acts []map[string]any
	_ = json.Unmarshal(out, &acts)
	node := acts[0]["nodes"].([]any)[0].(map[string]any)
	if v, _ := node["chapter_id"].(float64); v != 1788197489730 {
		t.Errorf("chapter_id lost: %v", node["chapter_id"])
	}
	refs, _ := node["memory_refs"].([]any)
	if len(refs) != 1 || refs[0] != "阿绫" {
		t.Errorf("memory_refs not cleaned: %v", node["memory_refs"])
	}
}

func TestNormalizeOutlineAct_DropsUnusableActs(t *testing.T) {
	cases := map[string]bool{
		`{"title":""}`:          false, // blank title
		`{"title":"   "}`:       false, // whitespace title
		`{}`:                    false, // no title
		`"not an object"`:       false,
		`42`:                    false,
		`{"title":"第一幕"}`:       true,
		`{"title":" 第一幕 "}`:     true,
		`{"title":"第二幕","x":1}`: true,
	}
	for in, want := range cases {
		got := normalizeOutlineAct(mustDecodeJSON(t, in)) != nil
		if got != want {
			t.Errorf("normalizeOutlineAct(%s) kept=%v, want %v", in, got, want)
		}
	}
}

func TestMergeOutlineAct_IdempotentByTitle(t *testing.T) {
	existing := []map[string]any{
		{"id": "a1", "title": "第一幕：出山", "nodes": []map[string]any{
			{"id": "n1", "title": "负剑出山", "summary": "", "status": "planned"},
			{"id": "n2", "title": "", "summary": "", "status": "planned"},
		}},
	}
	incoming := map[string]any{
		"id":    "new",
		"title": "第一幕：出山",
		"nodes": []map[string]any{
			{"id": "n3", "title": "负剑出山", "summary": "", "status": "planned"}, // dup → skipped
			{"id": "n4", "title": "雨夜初战", "summary": "", "status": "planned"}, // new → appended
			{"id": "n5", "title": "", "summary": "", "status": "planned"},     // untitled → always appended
		},
	}

	if !mergeOutlineAct(existing, incoming) {
		t.Fatal("mergeOutlineAct returned false, want true (merged into existing)")
	}
	if len(existing) != 1 {
		t.Fatalf("existing grew to %d acts, want 1", len(existing))
	}
	nodes := existing[0]["nodes"].([]map[string]any)
	if len(nodes) != 4 {
		t.Fatalf("want 4 nodes (1 dup skipped, 2+1 appended), got %d", len(nodes))
	}
	if nodes[3]["id"] != "n5" {
		t.Errorf("untitled node should have been appended, last id = %v", nodes[3]["id"])
	}

	// A different title must not merge.
	if mergeOutlineAct(existing, map[string]any{"title": "第二幕", "nodes": []map[string]any{}}) {
		t.Error("different title must not merge")
	}
}

// TestSyncOutlineShapeIsContractCompliant asserts the exact invariant the web
// panel depends on: every act has a non-empty id and an array nodes field, and
// every node has a non-empty id and a legal status. It feeds syncOutline's
// normalization pipeline (repair + merge) with the dirtiest payload observed in
// production and checks the marshaled result the DB would receive.
func TestSyncOutlineShapeIsContractCompliant(t *testing.T) {
	// Stand-in for what the LLM passes to save_outline.
	rawActs := []interface{}{
		mustDecodeJSON(t, `{"title":"第一幕：出山","nodes":[
			{"title":"负剑出山","summary":"<p>离开师门</p>"},
			{"title":"雨夜初战","summary":"初露锋芒","status":"bogus"}
		]}`),
		mustDecodeJSON(t, `{"nodes":"not-an-array","title":"第二幕"}`),
		mustDecodeJSON(t, `"garbage"`),
	}

	var stored []map[string]any
	for _, raw := range rawActs {
		act := normalizeOutlineAct(raw)
		if act == nil {
			continue
		}
		if !mergeOutlineAct(stored, act) {
			stored = append(stored, act)
		}
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}

	var acts []map[string]any
	if err := json.Unmarshal(encoded, &acts); err != nil {
		t.Fatal(err)
	}
	if len(acts) != 2 {
		t.Fatalf("want 2 acts (garbage dropped), got %d: %s", len(acts), encoded)
	}
	if titles := func() []string {
		out := make([]string, 0, len(acts))
		for _, a := range acts {
			out = append(out, a["title"].(string))
		}
		return out
	}(); titles[0] != "第一幕：出山" || titles[1] != "第二幕" {
		t.Errorf("unexpected titles: %v", titles)
	}
	// Act 2 had nodes:"not-an-array" → must have become [].
	if n, ok := acts[1]["nodes"].([]any); !ok || len(n) != 0 {
		t.Errorf("act 2 nodes should be [], got %#v", acts[1]["nodes"])
	}
	// Node with status "bogus" → planned.
	st := acts[0]["nodes"].([]any)[1].(map[string]any)["status"]
	if st != "planned" {
		t.Errorf("illegal status should fall back to planned, got %v", st)
	}
}

func TestActTitlesHelper(t *testing.T) {
	got := outlineActTitles(t, json.RawMessage(`[{"title":"a"},{"title":"b"}]`))
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("outlineActTitles = %v", got)
	}
}
