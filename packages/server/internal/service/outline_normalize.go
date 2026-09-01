package service

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/inkbloom/server/internal/pkg/idgen"
)

// outlineOrdinalRe matches a leading Chinese/Arabic ordinal prefix at the
// MACRO level only — "第一幕", "第三卷", "第二部", "第一篇" — so that
// "第一幕《神陨之后》" and "神陨之后" normalize to the same key (R1 outline
// dedup). Chapter-level ordinals ("第N章/节/回") are deliberately NOT stripped
// here: outline nodes such as "第一章 觉醒" and "第二章 觉醒" are distinct
// chapters and must not collapse to the same key (B5). Chapter resolution uses
// chapterOrdinalRe instead. The regex anchors at ^ and runs immediately after 第
// with no whitespace, so "第 1 幕" (with a space) is left untouched.
var outlineOrdinalRe = regexp.MustCompile(`^第[一二三四五六七八九十百千零0-9]+[幕卷部篇]`)

// chapterOrdinalRe matches a leading ordinal at ANY granularity — 幕/卷/部/篇 as
// well as 章/节/回 — for resolving a user's "第N章/某章" phrasing to a real
// chapter title (get_chapter_by_title). Chapter titles legitimately repeat
// across ordinals, so the chapter-lookup key is broader than outlineOrdinalRe.
var chapterOrdinalRe = regexp.MustCompile(`^第[一二三四五六七八九十百千零0-9]+[幕章节卷部篇回]`)

// outlineTitleStrip removes book-title / quoting marks so titles wrapped in
// 《》「」（）""''() etc. compare equal to their bare form.
var outlineTitleStrip = strings.NewReplacer(
	"《", "", "》", "",
	"\"", "", "'", "",
	"（", "", "）", "",
	"(", "", ")", "",
	"「", "", "」", "",
	"『", "", "』", "",
)

// Outline node lifecycle statuses — the closed set the web outline contract
// (`packages/web/src/stores/outline-store.ts`) allows. Anything else, including
// a missing status, falls back to "planned".
const (
	outlineStatusPlanned  = "planned"
	outlineStatusDrafting = "drafting"
	outlineStatusDone     = "done"
)

// isOutlineStatus reports whether s is one of the three legal node statuses.
func isOutlineStatus(s string) bool {
	switch s {
	case outlineStatusPlanned, outlineStatusDrafting, outlineStatusDone:
		return true
	}
	return false
}

// normalizeOutlineActsJSON re-encodes raw stored acts into the canonical wire
// shape required by the web outline contract:
//
//	[{"id": string, "title": string, "nodes": [
//	   {"id": string, "title": string, "summary": string,
//	    "status": "planned"|"drafting"|"done"}]}]
//
// It is the single repair point for every source of outline data — LLM tool
// output, legacy rows written before normalization existed, and client PUTs.
// Unknown keys (chapter_id, memory_refs, ...) are preserved verbatim so no data
// is lost, and a corrupt document degrades to an empty array instead of an
// error: one bad row can never take down the outline API or the panel.
func normalizeOutlineActsJSON(raw json.RawMessage) json.RawMessage {
	var acts []map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &acts)
	}
	out := make([]map[string]any, 0, len(acts))
	for _, item := range acts {
		if act := repairOutlineAct(item); act != nil {
			out = append(out, act)
		}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		// Unreachable: a slice of maps holding JSON-native values always encodes.
		return json.RawMessage("[]")
	}
	return encoded
}

// repairOutlineAct fills in every act field the web contract requires that is
// missing or of the wrong type, leaving all other keys untouched. It returns
// nil only when the input is not a JSON object at all.
//
// Unlike normalizeOutlineAct it never discards the act, so a blank-titled act
// the user typed themselves survives a round-trip.
func repairOutlineAct(raw any) map[string]any {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	if id, _ := m["id"].(string); strings.TrimSpace(id) == "" {
		m["id"] = idgen.NewID()
	}
	if _, ok := m["title"].(string); !ok {
		m["title"] = ""
	}
	m["nodes"] = normalizeOutlineNodes(m["nodes"])
	return m
}

// normalizeOutlineAct validates one Agent-produced act and returns it in
// canonical form. It returns nil when the act is unusable — not a JSON object,
// or a blank title — so malformed LLM output is silently skipped rather than
// written to the database.
func normalizeOutlineAct(raw any) map[string]any {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	title, _ := m["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		return nil
	}
	act := repairOutlineAct(m)
	act["title"] = title
	return act
}

// normalizeOutlineNodes coerces an arbitrary value into a valid outline node
// list. Non-arrays become an empty list, non-object entries are dropped, and
// every surviving node leaves with an id, string title, string summary, a legal
// status and a numeric-or-absent chapter_id.
func normalizeOutlineNodes(raw any) []map[string]any {
	items, ok := raw.([]interface{})
	if !ok {
		return []map[string]any{}
	}
	nodes := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := m["id"].(string); strings.TrimSpace(id) == "" {
			m["id"] = idgen.NewID()
		}
		if _, ok := m["title"].(string); !ok {
			m["title"] = ""
		}
		// summary carries an HTML fragment — assigned verbatim, never escaped.
		if _, ok := m["summary"].(string); !ok {
			m["summary"] = ""
		}
		if status, _ := m["status"].(string); !isOutlineStatus(status) {
			m["status"] = outlineStatusPlanned
		}
		// chapter_id must stay numeric: the client compares it against numeric
		// chapter ids, so a string/null value is dropped instead of poisoning
		// the "已扩写成稿" counts.
		if _, ok := m["chapter_id"].(float64); !ok {
			delete(m, "chapter_id")
		}
		if refs, ok := m["memory_refs"].([]interface{}); ok {
			cleaned := make([]string, 0, len(refs))
			for _, r := range refs {
				if s, ok := r.(string); ok {
					cleaned = append(cleaned, s)
				}
			}
			m["memory_refs"] = cleaned
		} else if _, exists := m["memory_refs"]; exists {
			m["memory_refs"] = []string{}
		}
		nodes = append(nodes, m)
	}
	return nodes
}

// mergeOutlineAct folds one normalized act into an existing act list. When an
// act with the same title already exists the incoming nodes are appended to it
// (skipping nodes whose non-empty title already exists) and true is returned;
// otherwise false is returned and the caller appends the act as a new one.
//
// Title-Keyed folding keeps repeated save_outline calls idempotent: re-running
// the Agent on the same plan updates the existing act instead of creating twin
// acts, which is what produced the mixed/duplicated rows the panel choked on.
func mergeOutlineAct(existing []map[string]any, incoming map[string]any) bool {
	key := outlineTitleKey(incoming["title"])
	incomingNodes, _ := incoming["nodes"].([]map[string]any)
	for _, act := range existing {
		if act == nil || outlineTitleKey(act["title"]) != key {
			continue
		}
		nodes, _ := act["nodes"].([]map[string]any)
		if nodes == nil {
			nodes = []map[string]any{}
		}
		seen := make(map[string]bool, len(nodes))
		for _, n := range nodes {
			if n != nil {
				seen[outlineTitleKey(n["title"])] = true
			}
		}
		for _, n := range incomingNodes {
			// Untitled nodes are always appended: the client legitimately holds
			// several blank placeholder nodes side by side.
			if t := outlineTitleKey(n["title"]); t != "" && seen[t] {
				continue
			}
			nodes = append(nodes, n)
			seen[outlineTitleKey(n["title"])] = true
		}
		act["nodes"] = nodes
		return true
	}
	return false
}

// outlineTitleKey collapses whitespace and strips wrapping/quote marks
// (《》「」（） etc.), then a MACRO ordinal prefix ("第一幕" / "第三卷" / "第二部" /
// "第一篇"), so phrasings like "第一幕《神陨之后》" and "神陨之后" dedupe to the
// SAME key (R1 outline dedup). Chapter-level ordinals (第N章/节/回) are kept:
// "第一章 觉醒" and "第二章 觉醒" produce distinct keys so distinct chapters are
// never folded together (B5). Chapter-lookup normalization is chapterTitleKey.
//
// The ordinal is stripped ONLY when a non-empty remainder survives: a bare
// ordinal such as "第二幕" keeps a distinct key instead of collapsing to "".
func outlineTitleKey(v any) string {
	return titleKey(v, outlineOrdinalRe)
}

// chapterTitleKey is outlineTitleKey but for chapter resolution: it strips a
// leading ordinal at ANY granularity (幕/卷/部/篇 and 章/节/回) so a user's
// "第48章《余生长歌》" resolves to a chapter titled "余生长歌". Used only by
// get_chapter_by_title — never for outline/act dedup, where chapter ordinals
// must be preserved.
func chapterTitleKey(v any) string {
	return titleKey(v, chapterOrdinalRe)
}

func titleKey(v any, ordinal *regexp.Regexp) string {
	s, _ := v.(string)
	s = strings.Join(strings.Fields(s), " ")
	s = outlineTitleStrip.Replace(s)
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return ""
	}
	ord := ordinal.ReplaceAllString(trimmed, "")
	ord = strings.TrimSpace(ord)
	if ord == "" {
		return trimmed
	}
	return ord
}

// dedupOutlineActs folds acts that share the same outlineTitleKey (R1 dedup)
// so that every writer of the outline — the web outline panel's PUT as well as
// the Agent's save_outline — is protected from near-duplicate acts such as
// "第一幕《神陨之后》" alongside "神陨之后".
//
// The fold is the same one the Agent path already applies (mergeOutlineAct):
// the second act's nodes are appended into the first, skipping nodes whose
// non-empty title already exists. When nothing folds, the caller's exact bytes
// are returned untouched, so the ordinary non-duplicate write path stays
// byte-identical to before and no client payload is needlessly rewritten.
func dedupOutlineActs(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var acts []map[string]any
	if err := json.Unmarshal(raw, &acts); err != nil || len(acts) == 0 {
		return raw
	}
	merged := make([]map[string]any, 0, len(acts))
	for _, item := range acts {
		act := repairOutlineAct(item)
		if act == nil {
			continue
		}
		if !mergeOutlineAct(merged, act) {
			merged = append(merged, act)
		}
	}
	// Nothing folded, or every act was unusable: keep the original bytes.
	if len(merged) == len(acts) {
		return raw
	}
	out, err := json.Marshal(merged)
	if err != nil {
		return raw
	}
	return out
}
