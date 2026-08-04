package format

import (
	"encoding/json"
	"strings"
	"testing"
)

// helper to build a TipTap doc from JSON
func parseDoc(t *testing.T, raw string) *TipTapNode {
	t.Helper()
	var doc TipTapNode
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("parse doc: %v", err)
	}
	return &doc
}

// --- FormatEngine tests ---

func TestFormatEngine_RegisterAndSupportedFormats(t *testing.T) {
	e := NewFormatEngine()
	e.RegisterRenderer(NewMarkdownRenderer())
	e.RegisterRenderer(NewHTMLRenderer())
	formats := e.SupportedFormats()
	if len(formats) != 2 {
		t.Fatalf("expected 2 formats, got %d", len(formats))
	}
	// sorted
	if formats[0] != "html" || formats[1] != "markdown" {
		t.Fatalf("unexpected formats: %v", formats)
	}
}

func TestFormatEngine_ConvertUnsupported(t *testing.T) {
	e := NewFormatEngine()
	_, err := e.Convert(json.RawMessage(`{}`), "unknown")
	if err == nil {
		t.Fatal("expected error for unsupported format")
	}
}

// --- Markdown Renderer tests ---

func TestMarkdownRenderer_Paragraph(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [{"type": "text", "text": "Hello World"}]}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "Hello World") {
		t.Fatalf("expected 'Hello World', got: %s", result)
	}
}

func TestMarkdownRenderer_Heading(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Title"}]}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "## Title") {
		t.Fatalf("expected '## Title', got: %s", result)
	}
}

func TestMarkdownRenderer_BoldItalic(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
				{"type": "text", "text": " and "},
				{"type": "text", "text": "italic", "marks": [{"type": "italic"}]}
			]}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "**bold**") {
		t.Fatalf("expected '**bold**', got: %s", result)
	}
	if !strings.Contains(result, "*italic*") {
		t.Fatalf("expected '*italic*', got: %s", result)
	}
}

func TestMarkdownRenderer_BulletList(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "bulletList", "content": [
				{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item1"}]}]},
				{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item2"}]}]}
			]}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "- item1") || !strings.Contains(result, "- item2") {
		t.Fatalf("expected bullet items, got: %s", result)
	}
}

func TestMarkdownRenderer_CodeBlock(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "codeBlock", "attrs": {"language": "go"}, "content": [{"type": "text", "text": "fmt.Println()"}]}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "```go") || !strings.Contains(result, "fmt.Println()") {
		t.Fatalf("expected code block, got: %s", result)
	}
}

func TestMarkdownRenderer_Image(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "image", "attrs": {"src": "https://example.com/img.png", "alt": "test image"}}
		]
	}`)
	r := NewMarkdownRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "![test image](https://example.com/img.png)") {
		t.Fatalf("expected image markdown, got: %s", result)
	}
}

// --- HTML Renderer tests ---

func TestHTMLRenderer_Paragraph(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]}
		]
	}`)
	r := NewHTMLRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "<p>Hello</p>") {
		t.Fatalf("expected <p>Hello</p>, got: %s", result)
	}
	if !strings.Contains(result, "<div>") {
		t.Fatalf("expected wrapping <div>, got: %s", result)
	}
}

func TestHTMLRenderer_Bold(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "text", "text": "bold", "marks": [{"type": "bold"}]}
			]}
		]
	}`)
	r := NewHTMLRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "<strong>bold</strong>") {
		t.Fatalf("expected <strong>bold</strong>, got: %s", result)
	}
}

func TestHTMLRenderer_Heading(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "H3"}]}
		]
	}`)
	r := NewHTMLRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "<h3>H3</h3>") {
		t.Fatalf("expected <h3>H3</h3>, got: %s", result)
	}
}

// --- Wechat Renderer tests ---

func TestWechatRenderer_InlineCSS(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [{"type": "text", "text": "WeChat content"}]}
		]
	}`)
	r := NewWechatRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "style=") {
		t.Fatalf("expected inline CSS styles, got: %s", result)
	}
	if !strings.Contains(result, "WeChat content") {
		t.Fatalf("expected content, got: %s", result)
	}
	if !strings.Contains(result, "-apple-system") {
		t.Fatalf("expected font-family, got: %s", result)
	}
}

// --- Zhihu Renderer tests ---

func TestZhihuRenderer_CodeBlockClass(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "codeBlock", "attrs": {"language": "python"}, "content": [{"type": "text", "text": "print()"}]}
		]
	}`)
	r := NewZhihuRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, `class="language-python"`) {
		t.Fatalf("expected language class, got: %s", result)
	}
}

// --- Qidian Renderer tests ---

func TestQidianRenderer_PlainText(t *testing.T) {
	doc := parseDoc(t, `{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
				{"type": "text", "text": " text"}
			]},
			{"type": "image", "attrs": {"src": "test.png"}}
		]
	}`)
	r := NewQidianRenderer()
	result, err := r.Render(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result, "<") || strings.Contains(result, "**") {
		t.Fatalf("expected plain text without formatting, got: %s", result)
	}
	if !strings.Contains(result, "bold text") {
		t.Fatalf("expected 'bold text', got: %s", result)
	}
	if !strings.Contains(result, "[图片]") {
		t.Fatalf("expected [图片] placeholder, got: %s", result)
	}
}

// --- Engine end-to-end ---

func TestFormatEngine_EndToEnd(t *testing.T) {
	e := NewFormatEngine()
	e.RegisterRenderer(NewMarkdownRenderer())
	e.RegisterRenderer(NewHTMLRenderer())
	e.RegisterRenderer(NewWechatRenderer())
	e.RegisterRenderer(NewZhihuRenderer())
	e.RegisterRenderer(NewQidianRenderer())

	input := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Test"}]},
			{"type": "paragraph", "content": [
				{"type": "text", "text": "Hello "},
				{"type": "text", "text": "world", "marks": [{"type": "bold"}]}
			]}
		]
	}`)

	for _, fmt := range e.SupportedFormats() {
		result, err := e.Convert(input, fmt)
		if err != nil {
			t.Fatalf("Convert(%s) failed: %v", fmt, err)
		}
		if result == "" {
			t.Fatalf("Convert(%s) returned empty", fmt)
		}
		t.Logf("Format %s: %s", fmt, result[:min(len(result), 80)])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
