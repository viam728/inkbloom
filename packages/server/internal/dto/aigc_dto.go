package dto

// ImageGenRequest is the request body for creating an AIGC image generation task.
type ImageGenRequest struct {
	Prompt    string `json:"prompt" binding:"required"`
	Width     int32  `json:"width"`
	Height    int32  `json:"height"`
	Provider  string `json:"provider"`
	NovelID   *int64 `json:"novel_id"`
	ChapterID *int64 `json:"chapter_id"`
}

// AIGCTaskResponse is the response for a created AIGC task.
type AIGCTaskResponse struct {
	TaskID   string `json:"task_id"`
	Type     string `json:"type"`
	Status   string `json:"status"`
	Progress int16  `json:"progress"`
}

// AIGCGeneratePayload is the JSON payload stored in the task and sent to the Python service.
type AIGCGeneratePayload struct {
	Prompt   string `json:"prompt"`
	Width    int32  `json:"width"`
	Height   int32  `json:"height"`
	Provider string `json:"provider"`
	NovelID  int64  `json:"novel_id"`
	Seed     int64  `json:"seed,omitempty"`
}

// AIGCGenerateResult is the result returned by the Python AIGC service.
type AIGCGenerateResult struct {
	URL           string `json:"url"`
	FilePath      string `json:"file_path"`
	ThumbnailPath string `json:"thumbnail_path"`
	Width         int32  `json:"width"`
	Height        int32  `json:"height"`
	Provider      string `json:"provider"`
	FileSize      int32  `json:"file_size"`
}
