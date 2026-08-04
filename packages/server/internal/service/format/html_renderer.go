package format

import (
	"fmt"
	"strings"
)

// HTMLRenderer renders TipTap AST to standard HTML.
type HTMLRenderer struct{}

func NewHTMLRenderer() *HTMLRenderer { return &HTMLRenderer{} }

func (r *HTMLRenderer) Name() string        { return "html" }
func (r *HTMLRenderer) DisplayName() string { return "HTML" }
func (r *HTMLRenderer) MimeType() string    { return "text/html" }

func (r *HTMLRenderer) Render(doc *TipTapNode) (string, error) {
	var b strings.Builder
	b.WriteString("<div>\n")
	renderHTMLNode(&b, doc)
	b.WriteString("</div>\n")
	return b.String(), nil
}

func renderHTMLNode(b *strings.Builder, node *TipTapNode) {
	switch node.Type {
	case "doc":
		for i := range node.Content {
			renderHTMLNode(b, &node.Content[i])
		}

	case "paragraph":
		b.WriteString("<p>")
		for i := range node.Content {
			renderHTMLInline(b, &node.Content[i])
		}
		b.WriteString("</p>\n")

	case "heading":
		level := 1
		if node.Attrs != nil {
			if l, ok := node.Attrs["level"]; ok {
				if n, ok := l.(float64); ok {
					level = int(n)
				}
			}
		}
		tag := fmt.Sprintf("h%d", level)
		b.WriteString(fmt.Sprintf("<%s>", tag))
		for i := range node.Content {
			renderHTMLInline(b, &node.Content[i])
		}
		b.WriteString(fmt.Sprintf("</%s>\n", tag))

	case "bulletList":
		b.WriteString("<ul>\n")
		for i := range node.Content {
			renderHTMLListItem(b, &node.Content[i])
		}
		b.WriteString("</ul>\n")

	case "orderedList":
		b.WriteString("<ol>\n")
		for i := range node.Content {
			renderHTMLListItem(b, &node.Content[i])
		}
		b.WriteString("</ol>\n")

	case "blockquote":
		b.WriteString("<blockquote>\n")
		for i := range node.Content {
			renderHTMLNode(b, &node.Content[i])
		}
		b.WriteString("</blockquote>\n")

	case "codeBlock":
		lang := ""
		if node.Attrs != nil {
			if l, ok := node.Attrs["language"].(string); ok {
				lang = l
			}
		}
		if lang != "" {
			b.WriteString(fmt.Sprintf("<pre><code class=\"language-%s\">", lang))
		} else {
			b.WriteString("<pre><code>")
		}
		for i := range node.Content {
			if node.Content[i].Type == "text" {
				b.WriteString(htmlEscape(node.Content[i].Text))
			}
		}
		b.WriteString("</code></pre>\n")

	case "image":
		src := ""
		alt := ""
		if node.Attrs != nil {
			if s, ok := node.Attrs["src"].(string); ok {
				src = s
			}
			if s, ok := node.Attrs["alt"].(string); ok {
				alt = s
			}
		}
		b.WriteString(fmt.Sprintf("<img src=\"%s\" alt=\"%s\">\n", htmlEscape(src), htmlEscape(alt)))

	case "hardBreak":
		b.WriteString("<br>\n")

	default:
		for i := range node.Content {
			renderHTMLNode(b, &node.Content[i])
		}
	}
}

func renderHTMLListItem(b *strings.Builder, node *TipTapNode) {
	b.WriteString("<li>")
	for i := range node.Content {
		child := &node.Content[i]
		if child.Type == "paragraph" {
			for j := range child.Content {
				renderHTMLInline(b, &child.Content[j])
			}
		} else if child.Type == "bulletList" || child.Type == "orderedList" {
			renderHTMLNode(b, child)
		} else {
			renderHTMLNode(b, child)
		}
	}
	b.WriteString("</li>\n")
}

func renderHTMLInline(b *strings.Builder, node *TipTapNode) {
	if node.Type == "text" {
		text := htmlEscape(node.Text)
		text = applyHTMLMarks(text, node.Marks)
		b.WriteString(text)
		return
	}
	if node.Type == "hardBreak" {
		b.WriteString("<br>")
		return
	}
	if node.Type == "image" {
		src := ""
		alt := ""
		if node.Attrs != nil {
			if s, ok := node.Attrs["src"].(string); ok {
				src = s
			}
			if s, ok := node.Attrs["alt"].(string); ok {
				alt = s
			}
		}
		b.WriteString(fmt.Sprintf("<img src=\"%s\" alt=\"%s\">", htmlEscape(src), htmlEscape(alt)))
		return
	}
	for i := range node.Content {
		renderHTMLInline(b, &node.Content[i])
	}
}

func applyHTMLMarks(text string, marks []TipTapMark) string {
	for _, m := range marks {
		switch m.Type {
		case "bold":
			text = "<strong>" + text + "</strong>"
		case "italic":
			text = "<em>" + text + "</em>"
		case "underline":
			text = "<u>" + text + "</u>"
		case "code":
			text = "<code>" + text + "</code>"
		case "strike":
			text = "<s>" + text + "</s>"
		case "link":
			href := ""
			if m.Attrs != nil {
				if h, ok := m.Attrs["href"].(string); ok {
					href = h
				}
			}
			text = fmt.Sprintf("<a href=\"%s\">%s</a>", htmlEscape(href), text)
		}
	}
	return text
}

func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	return s
}
