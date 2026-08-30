// Package contentsanitize strips HTML down to a whitelist before published
// content is stored or served.
//
// Why it exists: chapter bodies are authored in TipTap but reach the server as
// ready-made HTML (the editor calls `getHTML()`), and the
// `inkbloom:insert-content` channel can inject arbitrary markup. Rendering
// that verbatim on a public, login-free reading page is a stored-XSS vector.
//
// Design notes:
//   - Built on golang.org/x/net/html (already in go.mod) rather than regex.
//     Regex cannot parse HTML; every regex sanitiser is eventually bypassed by
//     malformed nesting.
//   - Unknown-but-harmless tags are *unwrapped* (children kept), not dropped,
//     so editor-generated wrappers like <div>/<span> don't eat body text.
//     Genuinely dangerous tags (script, style, iframe, ...) are dropped with
//     their entire subtree.
//   - All attributes are dropped except an explicit per-tag whitelist, and
//     every URL passes a scheme check. `style` is dropped entirely for v1:
//     keeping text-align would need a CSS mini-parser, and centred body text
//     is rare enough to lose. Revisit only if authors complain.
package contentsanitize

import (
	"bytes"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// allowedTags is the set of tags that survive sanitisation.
var allowedTags = map[atom.Atom]struct{}{
	atom.P:          {},
	atom.H1:         {},
	atom.H2:         {},
	atom.H3:         {},
	atom.Strong:     {},
	atom.Em:         {},
	atom.U:          {},
	atom.S:          {},
	atom.Ul:         {},
	atom.Ol:         {},
	atom.Li:         {},
	atom.Blockquote: {},
	atom.Code:       {},
	atom.Pre:        {},
	atom.Br:         {},
	atom.Hr:         {},
	atom.A:          {},
	atom.Img:        {},
}

// dropSubtree lists tags removed together with everything they contain.
// Their text is not authoring content — it is code, styling or embedded
// frames — so unwrapping would be worse than dropping.
var dropSubtree = map[atom.Atom]struct{}{
	atom.Script:   {},
	atom.Style:    {},
	atom.Iframe:   {},
	atom.Object:   {},
	atom.Embed:    {},
	atom.Link:     {},
	atom.Meta:     {},
	atom.Base:     {},
	atom.Form:     {},
	atom.Input:    {},
	atom.Button:   {},
	atom.Textarea: {},
	atom.Select:   {},
	atom.Option:   {},
	atom.Svg:      {},
	atom.Math:     {},
	atom.Title:    {},
	atom.Head:     {},
	atom.Noscript: {},
	atom.Template: {},
}

// allowedAttrs is the per-tag attribute whitelist. Tags absent from this map
// keep no attributes at all — that is how event handlers (`onerror` and
// friends) are removed without maintaining a blocklist that will always lag.
var allowedAttrs = map[atom.Atom]map[string]struct{}{
	atom.A:   {"href": {}, "title": {}},
	atom.Img: {"src": {}, "alt": {}, "title": {}},
}

// SafeHTML sanitises an HTML fragment, returning markup that is safe to
// render with dangerouslySetInnerHTML on a public page.
//
// On parse failure it returns an empty string rather than the input: falling
// back to raw output would defeat the whole point, and losing one rendering
// is cheaper than serving executable markup.
func SafeHTML(input string) string {
	if strings.TrimSpace(input) == "" {
		return ""
	}
	// ParseFragment with a body context keeps the input as a fragment instead
	// of promoting it to a full <html><head><body> document.
	ctx := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	nodes, err := html.ParseFragment(strings.NewReader(input), ctx)
	if err != nil {
		return ""
	}

	var buf bytes.Buffer
	for _, n := range nodes {
		if err := renderSanitized(&buf, n); err != nil {
			return ""
		}
	}
	return buf.String()
}

// renderSanitized writes the sanitised form of n (and its siblings' subtree)
// into w. Children of unwrapped tags are rendered in place.
func renderSanitized(w *bytes.Buffer, n *html.Node) error {
	switch n.Type {
	case html.TextNode:
		// html.EscapeString would double-escape entities that the parser
		// already decoded; Render handles escaping per node type instead.
		return html.Render(w, n)

	case html.CommentNode:
		return nil // comments can carry conditional-execution payloads

	case html.DoctypeNode, html.DocumentNode:
		return nil

	case html.ElementNode:
		if _, bad := dropSubtree[n.DataAtom]; bad {
			return nil
		}
		if _, ok := allowedTags[n.DataAtom]; !ok {
			// Unwrap: keep the children, drop the tag itself.
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if err := renderSanitized(w, c); err != nil {
					return err
				}
			}
			return nil
		}
		return renderAllowedElement(w, n)

	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if err := renderSanitized(w, c); err != nil {
				return err
			}
		}
		return nil
	}
}

// renderAllowedElement emits a whitelisted tag with its whitelisted attributes.
func renderAllowedElement(w *bytes.Buffer, n *html.Node) error {
	attrs := make([]html.Attribute, 0, 2)
	permitted, ok := allowedAttrs[n.DataAtom]
	if ok {
		for _, a := range n.Attr {
			if _, allowed := permitted[strings.ToLower(a.Key)]; !allowed {
				continue
			}
			val := a.Val
			if a.Key == "href" || a.Key == "src" {
				safe, isSafe := safeURL(val)
				if !isSafe {
					continue
				}
				val = safe
			}
			attrs = append(attrs, html.Attribute{Key: a.Key, Val: val})
		}
	}

	out := &html.Node{
		Type:     html.ElementNode,
		Data:     n.Data,
		DataAtom: n.DataAtom,
		Attr:     attrs,
	}
	// Render the open tag and close tag by hand so we can stream children
	// through the sanitiser instead of re-emitting them verbatim.
	if err := renderOpenTag(w, out); err != nil {
		return err
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if err := renderSanitized(w, c); err != nil {
			return err
		}
	}
	return renderCloseTag(w, out)
}

// voidTags need no closing tag.
var voidTags = map[atom.Atom]struct{}{
	atom.Br:  {},
	atom.Hr:  {},
	atom.Img: {},
}

func renderOpenTag(w *bytes.Buffer, n *html.Node) error {
	w.WriteByte('<')
	w.WriteString(n.Data)
	for _, a := range n.Attr {
		w.WriteString(` `)
		w.WriteString(a.Key)
		w.WriteString(`="`)
		w.WriteString(html.EscapeString(a.Val))
		w.WriteByte('"')
	}
	if _, void := voidTags[n.DataAtom]; void {
		w.WriteString(" />")
		return nil
	}
	w.WriteByte('>')
	return nil
}

func renderCloseTag(w *bytes.Buffer, n *html.Node) error {
	if _, void := voidTags[n.DataAtom]; void {
		return nil
	}
	w.WriteString("</")
	w.WriteString(n.Data)
	w.WriteByte('>')
	return nil
}

// safeURL reports whether raw is safe to use in href/src and returns the
// normalised form.
//
// Control characters are stripped before the scheme check: `java\0script:`
// and `java\tscript:` are classical parser-differential bypasses.
func safeURL(raw string) (string, bool) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '\x00', '\t', '\n', '\r', ' ':
			return -1
		}
		return r
	}, raw)
	lower := strings.ToLower(cleaned)

	switch {
	case strings.HasPrefix(lower, "http://"),
		strings.HasPrefix(lower, "https://"),
		strings.HasPrefix(lower, "mailto:"):
		return cleaned, true
	case strings.HasPrefix(lower, "data:image/"):
		// Inline images only; data:text/html would be an XSS payload.
		return cleaned, true
	case strings.HasPrefix(cleaned, "/"), strings.HasPrefix(cleaned, "./"), strings.HasPrefix(cleaned, "../"):
		// Relative URLs are fine: they stay on our own origin.
		return cleaned, true
	default:
		// javascript:, vbscript:, data:text/html, and anything unknown.
		return "", false
	}
}
