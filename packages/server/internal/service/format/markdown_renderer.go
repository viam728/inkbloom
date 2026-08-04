package format

import (
	"fmt"
	"strings"
)

// MarkdownRenderer renders TipTap AST to Markdown.
type MarkdownRenderer struct{}

func NewMarkdownRenderer() *MarkdownRenderer { return &MarkdownRenderer{} }

func (r *MarkdownRenderer) Name() string        { return "markdown" }
func (r *MarkdownRenderer) DisplayName() string { return "Markdown" }
func (r *MarkdownRenderer) MimeType() string    { return "text/markdown" }

func (r *MarkdownRenderer) Render(doc *TipTapNode) (string, error) {
	var b strings.Builder
	renderMarkdownNode(&b, doc, 0)
	return strings.TrimSpace(b.String()) + "\n", nil
}

func renderMarkdownNode(b *strings.Builder, node *TipTapNode, listDepth int) {
	switch node.Type {
	case "doc":
		for i := range node.Content {
			renderMarkdownNode(b, &node.Content[i], listDepth)
		}

	case "paragraph":
		for i := range node.Content {
			renderMarkdownInline(b, &node.Content[i])
		}
		b.WriteString("\n\n")

	case "heading":
		level := 1
		if node.Attrs != nil {
			if l, ok := node.Attrs["level"]; ok {
				if n, ok := l.(float64); ok {
					level = int(n)
				}
			}
		}
		b.WriteString(strings.Repeat("#", level) + " ")
		for i := range node.Content {
			renderMarkdownInline(b, &node.Content[i])
		}
		b.WriteString("\n\n")

	case "bulletList":
		for i := range node.Content {
			renderMarkdownListItem(b, &node.Content[i], listDepth, false, 0)
		}
		if listDepth == 0 {
			b.WriteString("\n")
		}

	case "orderedList":
		for i := range node.Content {
			renderMarkdownListItem(b, &node.Content[i], listDepth, true, i+1)
		}
		if listDepth == 0 {
			b.WriteString("\n")
		}

	case "blockquote":
		var inner strings.Builder
		for i := range node.Content {
			renderMarkdownNode(&inner, &node.Content[i], listDepth)
		}
		for _, line := range strings.Split(strings.TrimRight(inner.String(), "\n"), "\n") {
			b.WriteString("> " + line + "\n")
		}
		b.WriteString("\n")

	case "codeBlock":
		lang := ""
		if node.Attrs != nil {
			if l, ok := node.Attrs["language"]; ok {
				if s, ok := l.(string); ok {
					lang = s
				}
			}
		}
		b.WriteString("```" + lang + "\n")
		for i := range node.Content {
			if node.Content[i].Type == "text" {
				b.WriteString(node.Content[i].Text)
			}
		}
		if !strings.HasSuffix(b.String(), "\n") {
			b.WriteString("\n")
		}
		b.WriteString("```\n\n")

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
		b.WriteString(fmt.Sprintf("![%s](%s)\n\n", alt, src))

	case "hardBreak":
		b.WriteString("\n\n")

	default:
		// Fallback: render children
		for i := range node.Content {
			renderMarkdownNode(b, &node.Content[i], listDepth)
		}
	}
}

func renderMarkdownListItem(b *strings.Builder, node *TipTapNode, depth int, ordered bool, index int) {
	indent := strings.Repeat("  ", depth)
	for i := range node.Content {
		child := &node.Content[i]
		if child.Type == "paragraph" {
			if ordered {
				b.WriteString(fmt.Sprintf("%s%d. ", indent, index))
			} else {
				b.WriteString(indent + "- ")
			}
			for j := range child.Content {
				renderMarkdownInline(b, &child.Content[j])
			}
			b.WriteString("\n")
		} else if child.Type == "bulletList" || child.Type == "orderedList" {
			for k := range child.Content {
				renderMarkdownListItem(b, &child.Content[k], depth+1, child.Type == "orderedList", k+1)
			}
		} else {
			renderMarkdownNode(b, child, depth+1)
		}
	}
}

func renderMarkdownInline(b *strings.Builder, node *TipTapNode) {
	if node.Type == "text" {
		text := node.Text
		text = applyMarkdownMarks(text, node.Marks)
		b.WriteString(text)
		return
	}
	if node.Type == "hardBreak" {
		b.WriteString("  \n")
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
		b.WriteString(fmt.Sprintf("![%s](%s)", alt, src))
		return
	}
	// Recurse into content for other inline nodes
	for i := range node.Content {
		renderMarkdownInline(b, &node.Content[i])
	}
}

func applyMarkdownMarks(text string, marks []TipTapMark) string {
	for _, m := range marks {
		switch m.Type {
		case "bold":
			text = "**" + text + "**"
		case "italic":
			text = "*" + text + "*"
		case "underline":
			text = "<u>" + text + "</u>"
		case "code":
			text = "`" + text + "`"
		case "strike":
			text = "~~" + text + "~~"
		case "link":
			href := ""
			if m.Attrs != nil {
				if h, ok := m.Attrs["href"].(string); ok {
					href = h
				}
			}
			text = "[" + text + "](" + href + ")"
		}
	}
	return text
}
