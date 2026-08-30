package contentsanitize

import "testing"

func TestSafeHTMLKeepsEditorialMarkup(t *testing.T) {
	// Ordinary prose must survive untouched — over-stripping is a bug too.
	cases := []struct{ in, want string }{
		{`<p>雨下了一整夜。</p>`, `<p>雨下了一整夜。</p>`},
		{`<h2>第一章</h2>`, `<h2>第一章</h2>`},
		{`<p><strong>刀</strong>与<em>鞘</em></p>`, `<p><strong>刀</strong>与<em>鞘</em></p>`},
		{`<blockquote>引文</blockquote>`, `<blockquote>引文</blockquote>`},
		{`<ul><li>甲</li><li>乙</li></ul>`, `<ul><li>甲</li><li>乙</li></ul>`},
		{`<p>上<br />下</p>`, `<p>上<br />下</p>`},
		// Unknown wrappers are unwrapped, not dropped: the text is content.
		{`<div><p>段落</p></div>`, `<p>段落</p>`},
		{`<span>行内</span>`, `行内`},
	}
	for _, c := range cases {
		if got := SafeHTML(c.in); got != c.want {
			t.Errorf("SafeHTML(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestSafeHTMLStripsScripts(t *testing.T) {
	cases := []struct{ name, in string }{
		{"script tag", `<p>前</p><script>alert(1)</script><p>后</p>`},
		{"img onerror", `<img src="x" onerror="alert(1)">`},
		{"svg onload", `<svg onload="alert(1)"></svg>`},
		{"iframe", `<iframe src="https://evil.example"></iframe>`},
		{"style tag", `<style>body{display:none}</style><p>正文</p>`},
		{"javascript href", `<a href="javascript:alert(1)">点我</a>`},
		{"entity-encoded js", `<a href="javascript&#58;alert(1)">点我</a>`},
		// NUL / tab inside the scheme are parser-differential bypasses, so the
		// bytes are assembled at runtime instead of embedded literally.
		{"null-byte js", `<a href="java` + "\x00" + `script:alert(1)">点我</a>`},
		{"tab-split js", "<a href=\"java\tscript:alert(1)\">点我</a>"},
		{"vbscript", `<a href="vbscript:msgbox(1)">点我</a>`},
		{"data text html", `<a href="data:text/html;base64,PHNjcmlwdD4=">点我</a>`},
		{"form exfiltration", `<form action="https://evil.example"><input name="a"></form>`},
		{"template", `<template><script>alert(1)</script></template>`},
	}
	for _, c := range cases {
		got := SafeHTML(c.in)
		for _, bad := range []string{
			"alert", "javascript", "vbscript", "evil.example", "msgbox",
			"onerror", "onload", "<script", "<iframe", "<style", "<form", "<svg",
		} {
			if containsFold(got, bad) {
				t.Errorf("%s: SafeHTML(%q) leaked %q, got %q", c.name, c.in, bad, got)
			}
		}
	}
}

func TestSafeHTMLKeepsSafeLinksAndImages(t *testing.T) {
	got := SafeHTML(`<p><a href="https://example.com/a?b=1">链</a><img src="https://cdn.example/x.jpg" alt="图"></p>`)
	want := `<p><a href="https://example.com/a?b=1">链</a><img src="https://cdn.example/x.jpg" alt="图" /></p>`
	if got != want {
		t.Errorf("\n got  %q\n want %q", got, want)
	}
}

func TestSafeHTMLStripsEventHandlerButKeepsText(t *testing.T) {
	// The paragraph is legitimate content; only the attribute must go.
	got := SafeHTML(`<p onclick="steal()">正文</p>`)
	if want := `<p>正文</p>`; got != want {
		t.Errorf("\n got  %q\n want %q", got, want)
	}
}

func TestSafeHTMLStripsStyleAttribute(t *testing.T) {
	// v1 drops style entirely rather than parsing CSS.
	got := SafeHTML(`<p style="background:url(javascript:alert(1))">正文</p>`)
	if want := `<p>正文</p>`; got != want {
		t.Errorf("\n got  %q\n want %q", got, want)
	}
}

func TestSafeHTMLUnclosedTagsDoNotLeak(t *testing.T) {
	// Malformed input must not trip the parser into emitting raw markup.
	got := SafeHTML(`<p>未闭合<script>alert(1)`)
	if containsFold(got, "alert") || containsFold(got, "<script") {
		t.Errorf("leaked script from malformed input: %q", got)
	}
}

func TestSafeHTMLBlankInput(t *testing.T) {
	if got := SafeHTML("   "); got != "" {
		t.Errorf("expected empty output for blank input, got %q", got)
	}
	if got := SafeHTML(""); got != "" {
		t.Errorf("expected empty output for empty input, got %q", got)
	}
}

func containsFold(s, sub string) bool {
	return indexOfFold(s, sub) >= 0
}

func indexOfFold(s, sub string) int {
	ls, lsub := len(s), len(sub)
	for i := 0; i+lsub <= ls; i++ {
		if foldEqual(s[i:i+lsub], sub) {
			return i
		}
	}
	return -1
}

func foldEqual(a, b string) bool {
	for i := 0; i < len(b); i++ {
		c := a[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != b[i] {
			return false
		}
	}
	return true
}
