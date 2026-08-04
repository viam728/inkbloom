package format

// TipTapNode represents a node in the TipTap JSON AST.
type TipTapNode struct {
	Type    string                 `json:"type"`
	Content []TipTapNode           `json:"content,omitempty"`
	Text    string                 `json:"text,omitempty"`
	Attrs   map[string]interface{} `json:"attrs,omitempty"`
	Marks   []TipTapMark           `json:"marks,omitempty"`
}

// TipTapMark represents a mark (inline formatting) in the TipTap AST.
type TipTapMark struct {
	Type  string                 `json:"type"`
	Attrs map[string]interface{} `json:"attrs,omitempty"`
}

// Renderer defines the interface for format-specific renderers.
type Renderer interface {
	Name() string        // "markdown", "html", "wechat", "zhihu", "qidian"
	DisplayName() string // 中文显示名
	Render(doc *TipTapNode) (string, error)
	MimeType() string // 用于剪贴板
}
