package repository

import (
	"context"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// KnowledgeRepository defines the interface for knowledge graph data access.
// Reads are scoped by user_id (M1 isolation); upserts rely on the caller
// (service layer) populating node/edge.UserID.
type KnowledgeRepository interface {
	// Nodes
	UpsertNode(ctx context.Context, node *model.KnowledgeNode) (*model.KnowledgeNode, error)
	GetNodesByNovel(ctx context.Context, userID, novelID int64) ([]model.KnowledgeNode, error)
	GetNodesByType(ctx context.Context, userID, novelID int64, nodeType string) ([]model.KnowledgeNode, error)

	// Edges
	UpsertEdge(ctx context.Context, edge *model.KnowledgeEdge) (*model.KnowledgeEdge, error)
	GetEdgesByNovel(ctx context.Context, userID, novelID int64) ([]model.KnowledgeEdge, error)

	// Graph
	GetGraph(ctx context.Context, userID, novelID int64) (nodes []model.KnowledgeNode, edges []model.KnowledgeEdge, err error)
}

// knowledgeRepository is the GORM implementation of KnowledgeRepository.
type knowledgeRepository struct {
	db *gorm.DB
}

// NewKnowledgeRepository creates a new KnowledgeRepository backed by GORM.
func NewKnowledgeRepository(db *gorm.DB) KnowledgeRepository {
	return &knowledgeRepository{db: db}
}

func (r *knowledgeRepository) UpsertNode(ctx context.Context, node *model.KnowledgeNode) (*model.KnowledgeNode, error) {
	// ON CONFLICT: merge by (novel_id, name, type) — update properties if provided
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "novel_id"}, {Name: "name"}, {Name: "type"}},
			DoUpdates: clause.AssignmentColumns([]string{"properties", "source_chapter_id"}),
		}).
		Create(node).Error
	if err != nil {
		return nil, err
	}

	// Re-fetch to get the full record
	var result model.KnowledgeNode
	err = r.db.WithContext(ctx).
		Scopes(scope.ForUser(node.UserID)).
		Where("novel_id = ? AND name = ? AND type = ?", node.NovelID, node.Name, node.Type).
		First(&result).Error
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func (r *knowledgeRepository) GetNodesByNovel(ctx context.Context, userID, novelID int64) ([]model.KnowledgeNode, error) {
	var nodes []model.KnowledgeNode
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Find(&nodes).Error
	return nodes, err
}

func (r *knowledgeRepository) GetNodesByType(ctx context.Context, userID, novelID int64, nodeType string) ([]model.KnowledgeNode, error) {
	var nodes []model.KnowledgeNode
	err := r.db.WithContext(ctx).
		Scopes(scope.ForUser(userID)).
		Where("novel_id = ? AND type = ?", novelID, nodeType).
		Find(&nodes).Error
	return nodes, err
}

func (r *knowledgeRepository) UpsertEdge(ctx context.Context, edge *model.KnowledgeEdge) (*model.KnowledgeEdge, error) {
	// ON CONFLICT: deduplicate by (novel_id, source_id, target_id, relation_type)
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "novel_id"}, {Name: "source_id"}, {Name: "target_id"}, {Name: "relation_type"}},
			DoUpdates: clause.AssignmentColumns([]string{"description", "source_chapter_id"}),
		}).
		Create(edge).Error
	if err != nil {
		return nil, err
	}

	// Re-fetch to get the full record
	var result model.KnowledgeEdge
	err = r.db.WithContext(ctx).
		Scopes(scope.ForUser(edge.UserID)).
		Where("novel_id = ? AND source_id = ? AND target_id = ? AND relation_type = ?",
			edge.NovelID, edge.SourceID, edge.TargetID, edge.RelationType).
		First(&result).Error
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func (r *knowledgeRepository) GetEdgesByNovel(ctx context.Context, userID, novelID int64) ([]model.KnowledgeEdge, error) {
	var edges []model.KnowledgeEdge
	err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Find(&edges).Error
	return edges, err
}

func (r *knowledgeRepository) GetGraph(ctx context.Context, userID, novelID int64) ([]model.KnowledgeNode, []model.KnowledgeEdge, error) {
	var nodes []model.KnowledgeNode
	var edges []model.KnowledgeEdge

	if err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Find(&nodes).Error; err != nil {
		return nil, nil, err
	}
	if err := r.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID).Find(&edges).Error; err != nil {
		return nil, nil, err
	}

	return nodes, edges, nil
}
