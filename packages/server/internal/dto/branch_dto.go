package dto

// CreateBranchRequest / UpdateBranchRequest back the world-branch tree
// (世界线) REST endpoints. ParentID/ChapterID use 0 = unset so JSON bodies
// can simply omit them.
type CreateBranchRequest struct {
	NovelID   int64  `json:"novel_id" binding:"required"`
	ParentID  int64  `json:"parent_id"`
	Title     string `json:"title" binding:"required"`
	Summary   string `json:"summary"`
	Source    string `json:"source"` // 'ai' | 'user'；空 = user
	ChapterID int64  `json:"chapter_id"`
}

type UpdateBranchRequest struct {
	Title     *string `json:"title"`
	Summary   *string `json:"summary"`
	ChapterID *int64  `json:"chapter_id"` // 0 = 解绑章节
}
