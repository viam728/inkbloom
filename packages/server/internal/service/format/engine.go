package format

import (
	"encoding/json"
	"fmt"
	"sort"
)

// FormatEngine is the central engine for TipTap AST format conversion.
type FormatEngine struct {
	renderers map[string]Renderer
}

// NewFormatEngine creates a new FormatEngine.
func NewFormatEngine() *FormatEngine {
	return &FormatEngine{
		renderers: make(map[string]Renderer),
	}
}

// RegisterRenderer registers a renderer by its Name().
func (e *FormatEngine) RegisterRenderer(r Renderer) {
	e.renderers[r.Name()] = r
}

// Convert parses the TipTap JSON AST and renders it in the requested format.
func (e *FormatEngine) Convert(contentJSON json.RawMessage, formatName string) (string, error) {
	r, ok := e.renderers[formatName]
	if !ok {
		return "", fmt.Errorf("unsupported format: %s", formatName)
	}

	var doc TipTapNode
	if err := json.Unmarshal(contentJSON, &doc); err != nil {
		return "", fmt.Errorf("invalid TipTap JSON: %w", err)
	}

	return r.Render(&doc)
}

// SupportedFormats returns the list of registered format names (sorted).
func (e *FormatEngine) SupportedFormats() []string {
	names := make([]string, 0, len(e.renderers))
	for n := range e.renderers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// GetRenderer returns a registered renderer by name.
func (e *FormatEngine) GetRenderer(name string) (Renderer, bool) {
	r, ok := e.renderers[name]
	return r, ok
}
