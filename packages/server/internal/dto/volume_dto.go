package dto

// CreateVolumeRequest is the request body for creating a volume.
type CreateVolumeRequest struct {
	NovelID int64  `json:"novel_id" binding:"required"`
	Title   string `json:"title" binding:"required,max=255"`
}

// UpdateVolumeRequest is the request body for updating a volume.
type UpdateVolumeRequest struct {
	Title *string `json:"title,omitempty"`
}

// VolumeResponse is the response body for a single volume.
type VolumeResponse struct {
	ID       int64  `json:"id"`
	NovelID  int64  `json:"novel_id"`
	Title    string `json:"title"`
	Position int    `json:"position"`
}
