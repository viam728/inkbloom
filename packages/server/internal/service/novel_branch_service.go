package service

import (
	"context"
	"errors"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
)

// ErrBranchTitleRequired guards empty branch titles at the service boundary.
var ErrBranchTitleRequired = errors.New("分支标题必填")

// BranchService manages the world-branch tree (世界线) of a novel.
type BranchService struct {
	repo repository.NovelBranchRepository
}

// NewBranchService creates a new BranchService.
func NewBranchService(repo repository.NovelBranchRepository) *BranchService {
	return &BranchService{repo: repo}
}

// List returns all branch nodes of a novel (flat; the client builds the tree).
func (s *BranchService) List(ctx context.Context, userID, novelID int64) ([]model.NovelBranch, error) {
	return s.repo.ListByNovel(ctx, userID, novelID)
}

// Create appends a node. parentID nil = mainline root.
func (s *BranchService) Create(ctx context.Context, userID int64, req *dto.CreateBranchRequest) (*model.NovelBranch, error) {
	if req.Title == "" {
		return nil, ErrBranchTitleRequired
	}
	b := &model.NovelBranch{
		UserID:   userID,
		NovelID:  req.NovelID,
		Title:    req.Title,
		Summary:  req.Summary,
		Source:   req.Source,
	}
	if b.Source == "" {
		b.Source = "user"
	}
	if req.ParentID > 0 {
		b.ParentID = &req.ParentID
	}
	if req.ChapterID > 0 {
		b.ChapterID = &req.ChapterID
	}
	if err := s.repo.Create(ctx, b); err != nil {
		return nil, err
	}
	return b, nil
}

// Update edits title/summary/chapter binding of a node.
func (s *BranchService) Update(ctx context.Context, userID, id int64, req *dto.UpdateBranchRequest) error {
	updates := map[string]any{}
	if req.Title != nil {
		updates["title"] = *req.Title
	}
	if req.Summary != nil {
		updates["summary"] = *req.Summary
	}
	if req.ChapterID != nil {
		if *req.ChapterID > 0 {
			updates["chapter_id"] = *req.ChapterID
		} else {
			updates["chapter_id"] = nil
		}
	}
	if len(updates) == 0 {
		return nil
	}
	return s.repo.Update(ctx, userID, id, updates)
}

// Delete removes a leaf node.
func (s *BranchService) Delete(ctx context.Context, userID, id int64) error {
	return s.repo.Delete(ctx, userID, id)
}

// DeleteSubtree removes a node and all descendants.
func (s *BranchService) DeleteSubtree(ctx context.Context, userID, id int64) error {
	return s.repo.DeleteSubtree(ctx, userID, id)
}
