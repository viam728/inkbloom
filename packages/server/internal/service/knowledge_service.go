package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/datatypes"
)

// KnowledgeService handles knowledge graph business logic.
type KnowledgeService struct {
	repo         repository.KnowledgeRepository
	aiServiceURL string
	httpClient   *http.Client
}

// NewKnowledgeService creates a new KnowledgeService.
func NewKnowledgeService(repo repository.KnowledgeRepository, aiServiceURL string) *KnowledgeService {
	return &KnowledgeService{
		repo:         repo,
		aiServiceURL: strings.TrimRight(aiServiceURL, "/"),
		httpClient:   &http.Client{Timeout: 5 * time.Minute},
	}
}

// GraphData wraps the graph response.
type GraphData struct {
	Nodes []dto.KnowledgeNodeData `json:"nodes"`
	Edges []dto.KnowledgeEdgeData `json:"edges"`
}

// ExtractFromChapter extracts entities and relations from a chapter and stores them.
func (s *KnowledgeService) ExtractFromChapter(ctx context.Context, novelID, chapterID int64, text string) error {
	// Call Python AI service to extract entities and relations
	reqBody := map[string]interface{}{
		"text":       text,
		"novel_id":   novelID,
		"chapter_id": chapterID,
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	upstreamURL := s.aiServiceURL + "/api/knowledge/extract"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create upstream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result struct {
		Entities []struct {
			Name        string `json:"name"`
			Type        string `json:"type"`
			Description string `json:"description"`
		} `json:"entities"`
		Relations []struct {
			SourceName  string `json:"source_name"`
			TargetName  string `json:"target_name"`
			RelationType string `json:"relation_type"`
			Description  string `json:"description"`
		} `json:"relations"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode AI response: %w", err)
	}

	// Store entities as nodes
	nodeMap := make(map[string]*model.KnowledgeNode) // name -> node
	for _, e := range result.Entities {
		nodeType := e.Type
		props, _ := json.Marshal(map[string]string{"description": e.Description})
		node := &model.KnowledgeNode{
			NovelID:         novelID,
			Name:            e.Name,
			Type:            &nodeType,
			Properties:      datatypes.JSON(props),
			SourceChapterID: &chapterID,
		}
		created, err := s.repo.UpsertNode(ctx, node)
		if err != nil {
			return fmt.Errorf("upsert node %q: %w", e.Name, err)
		}
		nodeMap[e.Name] = created
	}

	// Store relations as edges
	for _, r := range result.Relations {
		sourceNode, ok := nodeMap[r.SourceName]
		if !ok {
			continue
		}
		targetNode, ok := nodeMap[r.TargetName]
		if !ok {
			continue
		}
		relationType := r.RelationType
		description := r.Description
		edge := &model.KnowledgeEdge{
			NovelID:         novelID,
			SourceID:        sourceNode.ID,
			TargetID:        targetNode.ID,
			RelationType:    &relationType,
			Description:     &description,
			SourceChapterID: &chapterID,
		}
		if _, err := s.repo.UpsertEdge(ctx, edge); err != nil {
			return fmt.Errorf("upsert edge: %w", err)
		}
	}

	return nil
}

// GetGraph retrieves the full knowledge graph for a novel.
func (s *KnowledgeService) GetGraph(ctx context.Context, novelID int64) (*GraphData, error) {
	nodes, edges, err := s.repo.GetGraph(ctx, novelID)
	if err != nil {
		return nil, fmt.Errorf("get graph: %w", err)
	}

	nodeData := make([]dto.KnowledgeNodeData, 0, len(nodes))
	for _, n := range nodes {
		nd := dto.KnowledgeNodeData{
			ID:              n.ID,
			Name:            n.Name,
			SourceChapterID: n.SourceChapterID,
		}
		if n.Type != nil {
			nd.Type = *n.Type
		}
		if n.Properties != nil {
			var props map[string]interface{}
			if err := json.Unmarshal(n.Properties, &props); err == nil {
				nd.Properties = props
			}
		}
		nodeData = append(nodeData, nd)
	}

	edgeData := make([]dto.KnowledgeEdgeData, 0, len(edges))
	for _, e := range edges {
		ed := dto.KnowledgeEdgeData{
			ID:              e.ID,
			SourceID:        e.SourceID,
			TargetID:        e.TargetID,
			SourceChapterID: e.SourceChapterID,
		}
		if e.RelationType != nil {
			ed.RelationType = *e.RelationType
		}
		if e.Description != nil {
			ed.Description = *e.Description
		}
		edgeData = append(edgeData, ed)
	}

	return &GraphData{Nodes: nodeData, Edges: edgeData}, nil
}

// CheckConsistency checks text consistency with existing knowledge.
func (s *KnowledgeService) CheckConsistency(ctx context.Context, novelID, chapterID int64, text string) ([]dto.ConsistencyIssue, error) {
	// Get existing entities for this novel
	existingNodes, err := s.repo.GetNodesByNovel(ctx, novelID)
	if err != nil {
		return nil, fmt.Errorf("get existing nodes: %w", err)
	}

	// Build entity list for consistency check
	entities := make([]map[string]interface{}, 0, len(existingNodes))
	for _, n := range existingNodes {
		e := map[string]interface{}{
			"name": n.Name,
		}
		if n.Type != nil {
			e["type"] = *n.Type
		}
		if n.Properties != nil {
			var props map[string]interface{}
			if err := json.Unmarshal(n.Properties, &props); err == nil {
				if desc, ok := props["description"]; ok {
					e["description"] = desc
				}
			}
		}
		entities = append(entities, e)
	}

	// Call Python AI service for consistency check
	reqBody := map[string]interface{}{
		"text":     text,
		"novel_id": novelID,
		"entities": entities,
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	upstreamURL := s.aiServiceURL + "/api/knowledge/check"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create upstream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result struct {
		Issues []dto.ConsistencyIssue `json:"issues"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode AI response: %w", err)
	}

	return result.Issues, nil
}
