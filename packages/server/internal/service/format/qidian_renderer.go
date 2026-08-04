package format

import (
	"strings"
)

// QidianRenderer renders TipTap AST to plain text for Qidian/web novel platforms.
type QidianRenderer struct{}

func NewQidianRenderer() *QidianRenderer { return &QidianRenderer{} }

func (r *QidianRenderer) Name() string        { return "qidian" }
func (r *QidianRenderer) DisplayName() string { return "起点/网文" }
func (r *QidianRenderer) MimeType() string    { return "text/plain" }

func (r *QidianRenderer) Render(doc *TipTapNode) (string, error) {
	var b strings.Builder
	renderQidianNode(&b, doc)
	return strings.TrimSpace(b.String()) + "\n", nil
}

func renderQidianNode(b *strings.Builder, node *TipTapNode) {
	switch node.Type {
	case "doc":
		for i := range node.Content {
			renderQidianNode(b, &node.Content[i])
		}

	case "paragraph":
		for i := range node.Content {
			renderQidianInline(b, &node.Content[i])
		}
		b.WriteString("\n\n")

	case "heading":
		// 起点格式: 第X章 标题 — use plain text for headings
		for i := range node.Content {
			renderQidianInline(b, &node.Content[i])
		}
		b.WriteString("\n\n")

	case "bulletList":
		for i := range node.Content {
			renderQidianListItem(b, &node.Content[i])
		}
		b.WriteString("\n")

	case "orderedList":
		for i := range node.Content {
			renderQidianListItem(b, &node.Content[i])
		}
		b.WriteString("\n")

	case "blockquote":
		for i := range node.Content {
			renderQidianNode(b, &node.Content[i])
		}

	case "codeBlock":
		// Plain text code blocks
		for i := range node.Content {
			if node.Content[i].Type == "text" {
				b.WriteString(node.Content[i].Text)
			}
		}
		b.WriteString("\n\n")

	case "image":
		// Skip images in plain text
		b.WriteString("[图片]\n\n")

	case "hardBreak":
		b.WriteString("\n\n")

	default:
		for i := range node.Content {
			renderQidianNode(b, &node.Content[i])
		}
	}
}

func renderQidianListItem(b *strings.Builder, node *TipTapNode) {
	for i := range node.Content {
		child := &node.Content[i]
		if child.Type == "paragraph" {
			for j := range child.Content {
				renderQidianInline(b, &child.Content[j])
			}
			b.WriteString("\n")
		} else {
			renderQidianNode(b, child)
		}
	}
}

func renderQidianInline(b *strings.Builder, node *TipTapNode) {
	if node.Type == "text" {
		b.WriteString(node.Text)
		return
	}
	if node.Type == "hardBreak" {
		b.WriteString("\n")
		return
	}
	for i := range node.Content {
		renderQidianInline(b, &node.Content[i])
	}
}
