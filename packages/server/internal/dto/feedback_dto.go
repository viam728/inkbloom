package dto

import "time"

// CreateFeedbackRequest is the POST /api/v1/feedback body (task #51, M6).
type CreateFeedbackRequest struct {
	Category string `json:"category" binding:"required"`
	Content  string `json:"content" binding:"required"`
	Contact  string `json:"contact"`
}

// FeedbackItem is one row of the back-office feedback list
// (GET /api/v1/admin/feedbacks), nickname joined from users.
type FeedbackItem struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Nickname  string    `json:"nickname"`
	Category  string    `json:"category"`
	Content   string    `json:"content"`
	Contact   string    `json:"contact"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// SetFeedbackStatusRequest is the POST /admin/feedbacks/:id/status body.
type SetFeedbackStatusRequest struct {
	Status string `json:"status" binding:"required"`
}
