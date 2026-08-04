package dto

// ExtractRequest is the request body for knowledge extraction.
type ExtractRequest struct {
	NovelID   int64  `json:"novel_id" binding:"required"`
	ChapterID int64  `json:"chapter_id" binding:"required"`
	Text      string `json:"text" binding:"required"`
}

// ConsistencyCheckRequest is the request body for consistency checking.
type ConsistencyCheckRequest struct {
	NovelID   int64  `json:"novel_id" binding:"required"`
	ChapterID int64  `json:"chapter_id" binding:"required"`
	Text      string `json:"text" binding:"required"`
}

// KnowledgeNodeData represents a knowledge node in API responses.
type KnowledgeNodeData struct {
	ID              int64                  `json:"id"`
	Name            string                 `json:"name"`
	Type            string                 `json:"type,omitempty"`
	Properties      map[string]interface{} `json:"properties,omitempty"`
	SourceChapterID *int64                 `json:"source_chapter_id,omitempty"`
}

// KnowledgeEdgeData represents a knowledge edge in API responses.
type KnowledgeEdgeData struct {
	ID              int64  `json:"id"`
	SourceID        int64  `json:"source_id"`
	TargetID        int64  `json:"target_id"`
	RelationType    string `json:"relation_type,omitempty"`
	Description     string `json:"description,omitempty"`
	SourceChapterID *int64 `json:"source_chapter_id,omitempty"`
}

// GraphData represents the full knowledge graph for a novel.
type GraphData struct {
	Nodes []KnowledgeNodeData `json:"nodes"`
	Edges []KnowledgeEdgeData `json:"edges"`
}

// ConsistencyIssue represents a detected consistency problem.
type ConsistencyIssue struct {
	Description string `json:"description"`
	Severity    string `json:"severity"`
	EntityName  string `json:"entity_name"`
}
