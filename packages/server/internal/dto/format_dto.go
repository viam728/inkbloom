package dto

import "encoding/json"

// FormatConvertRequest is the request body for format conversion.
type FormatConvertRequest struct {
	ContentJSON json.RawMessage `json:"content_json" binding:"required"`
	Format      string          `json:"format" binding:"required"`
}

// FormatConvertResponse is the response body for format conversion.
type FormatConvertResponse struct {
	Content  string `json:"content"`
	Format   string `json:"format"`
	MimeType string `json:"mime_type"`
}

// FormatPreviewRequest is the request body for format preview.
type FormatPreviewRequest struct {
	ContentJSON json.RawMessage `json:"content_json" binding:"required"`
	Format      string          `json:"format" binding:"required"`
}

// FormatPreviewResponse is the response body for format preview.
type FormatPreviewResponse struct {
	HTML string `json:"html"`
}

// ExportRequest is the request body for export endpoints.
type ExportRequest struct {
	Format string `json:"format" binding:"required"`
}
