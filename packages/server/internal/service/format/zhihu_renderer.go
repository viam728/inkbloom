package format

import (
	"fmt"
	"strings"
)

// ZhihuRenderer renders TipTap AST to Zhihu-compatible HTML.
type ZhihuRenderer struct{}

func NewZhihuRenderer() *ZhihuRenderer { return &ZhihuRenderer{} }

func (r *ZhihuRenderer) Name() string        { return "zhihu" }
func (r *ZhihuRenderer) DisplayName() string { return "知乎" }
func (r *ZhihuRenderer) MimeType() string    { return "text/html" }

func (r *ZhihuRenderer) Render(doc *TipTapNode) (string, error) {
	var b strings.Builder
	renderZhihuNode(&b, doc)
	return strings.TrimSpace(b.String()) + "\n", nil
}

func renderZhihuNode(b *strings.Builder, node *TipTapNode) {
	switch node.Type {
	case "doc":
		for i := range node.Content {
			renderZhihuNode(b, &node.Content[i])
		}

	case "paragraph":
		b.WriteString("<p>")
		for i := range node.Content {
			renderZhihuInline(b, &node.Content[i])
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
			renderZhihuInline(b, &node.Content[i])
		}
		b.WriteString(fmt.Sprintf("</%s>\n", tag))

	case "bulletList":
		b.WriteString("<ul>\n")
		for i := range node.Content {
			renderZhihuListItem(b, &node.Content[i])
		}
		b.WriteString("</ul>\n")

	case "orderedList":
		b.WriteString("<ol>\n")
		for i := range node.Content {
			renderZhihuListItem(b, &node.Content[i])
		}
		b.WriteString("</ol>\n")

	case "blockquote":
		b.WriteString("<blockquote>\n")
		for i := range node.Content {
			renderZhihuNode(b, &node.Content[i])
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
			b.WriteString("<pre><code class=\"language-\">")
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
			renderZhihuNode(b, &node.Content[i])
		}
	}
}

func renderZhihuListItem(b *strings.Builder, node *TipTapNode) {
	b.WriteString("<li>")
	for i := range node.Content {
		child := &node.Content[i]
		if child.Type == "paragraph" {
			for j := range child.Content {
				renderZhihuInline(b, &child.Content[j])
			}
		} else {
			renderZhihuNode(b, child)
		}
	}
	b.WriteString("</li>\n")
}

func renderZhihuInline(b *strings.Builder, node *TipTapNode) {
	if node.Type == "text" {
		text := htmlEscape(node.Text)
		text = applyHTMLMarks(text, node.Marks) // reuse HTML mark formatting
		b.WriteString(text)
		return
	}
	if node.Type == "hardBreak" {
		b.WriteString("<br>")
		return
	}
	for i := range node.Content {
		renderZhihuInline(b, &node.Content[i])
	}
}
