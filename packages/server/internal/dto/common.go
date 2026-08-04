package dto

// APIResponse is the unified response wrapper for all API endpoints.
type APIResponse struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}
