package format

import (
	"fmt"
	"strings"
)

// WechatRenderer renders TipTap AST to HTML with inline CSS for WeChat.
type WechatRenderer struct{}

func NewWechatRenderer() *WechatRenderer { return &WechatRenderer{} }

func (r *WechatRenderer) Name() string        { return "wechat" }
func (r *WechatRenderer) DisplayName() string { return "微信公众号" }
func (r *WechatRenderer) MimeType() string    { return "text/html" }

const wechatFontFamily = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

func (r *WechatRenderer) Render(doc *TipTapNode) (string, error) {
	var b strings.Builder
	b.WriteString(fmt.Sprintf(`<section style="font-family:%s;font-size:16px;line-height:1.8;color:#333;padding:16px;">`, wechatFontFamily))
	b.WriteString("\n")
	renderWechatNode(&b, doc)
	b.WriteString("</section>\n")
	return b.String(), nil
}

func renderWechatNode(b *strings.Builder, node *TipTapNode) {
	switch node.Type {
	case "doc":
		for i := range node.Content {
			renderWechatNode(b, &node.Content[i])
		}

	case "paragraph":
		b.WriteString(`<section style="margin-bottom:16px;font-size:16px;line-height:1.8;color:#333;">`)
		for i := range node.Content {
			renderWechatInline(b, &node.Content[i])
		}
		b.WriteString("</section>\n")

	case "heading":
		level := 1
		if node.Attrs != nil {
			if l, ok := node.Attrs["level"]; ok {
				if n, ok := l.(float64); ok {
					level = int(n)
				}
			}
		}
		var fontSize, marginTop, marginBottom string
		switch level {
		case 1:
			fontSize = "24px"
			marginTop = "32px"
			marginBottom = "20px"
		case 2:
			fontSize = "22px"
			marginTop = "24px"
			marginBottom = "16px"
		default:
			fontSize = "18px"
			marginTop = "20px"
			marginBottom = "12px"
		}
		b.WriteString(fmt.Sprintf(`<h%d style="font-size:%s;font-weight:bold;color:#1a1a1a;margin:%s 0 %s;">`, level, fontSize, marginTop, marginBottom))
		for i := range node.Content {
			renderWechatInline(b, &node.Content[i])
		}
		b.WriteString(fmt.Sprintf("</h%d>\n", level))

	case "bulletList":
		b.WriteString(`<ul style="margin:16px 0;padding-left:24px;">`)
		b.WriteString("\n")
		for i := range node.Content {
			renderWechatListItem(b, &node.Content[i])
		}
		b.WriteString("</ul>\n")

	case "orderedList":
		b.WriteString(`<ol style="margin:16px 0;padding-left:24px;">`)
		b.WriteString("\n")
		for i := range node.Content {
			renderWechatListItem(b, &node.Content[i])
		}
		b.WriteString("</ol>\n")

	case "blockquote":
		b.WriteString(`<blockquote style="border-left:4px solid #ddd;padding-left:16px;color:#666;margin:16px 0;font-style:italic;">`)
		b.WriteString("\n")
		for i := range node.Content {
			renderWechatNode(b, &node.Content[i])
		}
		b.WriteString("</blockquote>\n")

	case "codeBlock":
		b.WriteString(`<pre style="background:#f5f5f5;padding:16px;border-radius:4px;overflow-x:auto;font-size:14px;line-height:1.6;margin:16px 0;"><code>`)
		for i := range node.Content {
			if node.Content[i].Type == "text" {
				b.WriteString(wechatEscape(node.Content[i].Text))
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
		b.WriteString(fmt.Sprintf(`<img src="%s" alt="%s" style="width:100%%;border-radius:4px;margin:16px 0;">`, wechatEscape(src), wechatEscape(alt)))
		b.WriteString("\n")

	case "hardBreak":
		b.WriteString("<br>\n")

	default:
		for i := range node.Content {
			renderWechatNode(b, &node.Content[i])
		}
	}
}

func renderWechatListItem(b *strings.Builder, node *TipTapNode) {
	b.WriteString(`<li style="margin-bottom:8px;">`)
	for i := range node.Content {
		child := &node.Content[i]
		if child.Type == "paragraph" {
			for j := range child.Content {
				renderWechatInline(b, &child.Content[j])
			}
		} else {
			renderWechatNode(b, child)
		}
	}
	b.WriteString("</li>\n")
}

func renderWechatInline(b *strings.Builder, node *TipTapNode) {
	if node.Type == "text" {
		text := wechatEscape(node.Text)
		text = applyWechatMarks(text, node.Marks)
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
		b.WriteString(fmt.Sprintf(`<img src="%s" alt="%s" style="width:100%%;border-radius:4px;margin:16px 0;">`, wechatEscape(src), wechatEscape(alt)))
		return
	}
	for i := range node.Content {
		renderWechatInline(b, &node.Content[i])
	}
}

func applyWechatMarks(text string, marks []TipTapMark) string {
	for _, m := range marks {
		switch m.Type {
		case "bold":
			text = `<strong style="color:#1a1a1a;">` + text + "</strong>"
		case "italic":
			text = `<em style="font-style:italic;">` + text + "</em>"
		case "underline":
			text = `<u style="text-decoration:underline;">` + text + "</u>"
		case "code":
			text = `<code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;font-size:14px;">` + text + "</code>"
		case "strike":
			text = `<s style="text-decoration:line-through;">` + text + "</s>"
		case "link":
			href := ""
			if m.Attrs != nil {
				if h, ok := m.Attrs["href"].(string); ok {
					href = h
				}
			}
			text = fmt.Sprintf(`<a href="%s" style="color:#576b95;text-decoration:underline;">%s</a>`, wechatEscape(href), text)
		}
	}
	return text
}

func wechatEscape(s string) string {
	return htmlEscape(s)
}
