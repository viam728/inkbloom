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
	"go.uber.org/zap"
)

// ErrStoryJobNotFound is returned when a story job does not exist or is not
// owned by the requesting user.
var ErrStoryJobNotFound = repository.ErrStoryJobNotFound

// StoryService drives the Agent full-book creation pipeline (story_jobs).
//
// The pipeline is a persistent state machine: a job starts from a one-line
// idea, advances stage by stage (idea → outline → plan_chapters →
// draft_chapter → verify → finalize → done), and each stage's output is
// materialised into the real creation structures (novel_outline, chapters,
// novel_memory) only after the author confirms it via the adopt endpoints.
// This keeps the AI output a preview until the author takes ownership.
type StoryService struct {
	repo           repository.StoryJobRepository
	novelRepo      repository.NovelRepository
	chapterRepo    repository.ChapterRepository
	docSvc         *NovelDocService
	chapterSvc     *ChapterService
	agentContext   *AgentContextService
	aiServiceURL   string
	httpClient     *http.Client
	logger         *zap.Logger
}

// NewStoryService creates a new StoryService.
func NewStoryService(
	repo repository.StoryJobRepository,
	novelRepo repository.NovelRepository,
	chapterRepo repository.ChapterRepository,
	docSvc *NovelDocService,
	chapterSvc *ChapterService,
	agentContext *AgentContextService,
	aiServiceURL string,
	logger *zap.Logger,
) *StoryService {
	return &StoryService{
		repo:         repo,
		novelRepo:    novelRepo,
		chapterRepo:  chapterRepo,
		docSvc:       docSvc,
		chapterSvc:   chapterSvc,
		agentContext: agentContext,
		aiServiceURL: strings.TrimRight(aiServiceURL, "/"),
		httpClient:   &http.Client{Timeout: 5 * time.Minute},
		logger:       logger,
	}
}

// CreateJob registers a new full-book creation job from a one-line idea.
func (s *StoryService) CreateJob(ctx context.Context, userID int64, req *dto.CreateStoryJobRequest) (*dto.StoryJobResponse, error) {
	if err := s.ownedNovel(ctx, userID, req.NovelID); err != nil {
		return nil, err
	}
	job := &model.StoryJob{
		UserID:       userID,
		NovelID:      req.NovelID,
		Title:        req.Title,
		Logline:      req.Logline,
		Stage:        model.StageIdea,
		Status:       model.StoryJobPending,
		TotalSteps:   5,
		StagePayload: []byte("{}"),
	}
	if err := s.repo.Create(ctx, job); err != nil {
		return nil, err
	}
	return s.toResponse(job), nil
}

// Get returns one job scoped to the user.
func (s *StoryService) Get(ctx context.Context, userID, id int64) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	return s.toResponse(job), nil
}

// List returns the user's jobs, optionally filtered by novel.
func (s *StoryService) List(ctx context.Context, userID int64, novelID int64, page, pageSize int) (*dto.ListStoryJobsResponse, error) {
	var jobs []model.StoryJob
	var total int64
	var err error
	if novelID > 0 {
		jobs, err = s.repo.ListByNovel(ctx, userID, novelID)
		total = int64(len(jobs))
	} else {
		jobs, total, err = s.repo.ListByUser(ctx, userID, page, pageSize)
	}
	if err != nil {
		return nil, err
	}
	resp := &dto.ListStoryJobsResponse{Total: total, Page: page, PageSize: pageSize}
	if jobs != nil {
		resp.Jobs = make([]dto.StoryJobResponse, 0, len(jobs))
		for i := range jobs {
			resp.Jobs = append(resp.Jobs, *s.toResponse(&jobs[i]))
		}
	} else {
		resp.Jobs = []dto.StoryJobResponse{}
	}
	return resp, nil
}

// Delete removes a job (does not touch already-adopted real content).
func (s *StoryService) Delete(ctx context.Context, userID, id int64) error {
	return s.repo.Delete(ctx, userID, id)
}

// GenerateStage runs the AI scene matching the job's current stage and stores
// the preview in StagePayload. It does NOT write into the real structures —
// the author confirms via Adopt*.
func (s *StoryService) GenerateStage(ctx context.Context, userID, id int64, instruction string) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}

	job.Status = model.StoryJobRunning
	scene, userPrompt := s.stageToScene(job, instruction)

	payload, err := s.agentContext.BuildAgentContext(ctx, userID, job.NovelID, scene, nil, nil, userPrompt)
	if err != nil {
		return nil, err
	}

	var out struct {
		Content string `json:"content"`
		Scene   string `json:"scene"`
		Error   string `json:"error"`
	}
	if err := s.postAI(ctx, "/api/agents/generate", payload, &out); err != nil {
		job.Status = model.StoryJobFailed
		job.LastError = err.Error()
		_ = s.repo.Update(ctx, job)
		return s.toResponse(job), err
	}
	if out.Error != "" {
		job.Status = model.StoryJobFailed
		job.LastError = out.Error
		_ = s.repo.Update(ctx, job)
		return s.toResponse(job), fmt.Errorf("AI stage failed: %s", out.Error)
	}

	job.StagePayload = mustJSON(map[string]interface{}{
		"scene":     scene,
		"content":   out.Content,
		"generated": time.Now().UTC(),
	})
	job.LastError = ""
	s.repo.Update(ctx, job)
	return s.toResponse(job), nil
}

// AdoptChapter confirms a drafted chapter and writes it into the novel's
// chapters table (real structure).
func (s *StoryService) AdoptChapter(ctx context.Context, userID, id int64, req *dto.AdoptChapterRequest) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}

	ch, err := s.chapterSvc.CreateChapter(ctx, userID, &dto.CreateChapterRequest{
		NovelID: job.NovelID,
		Title:   req.Title,
		Content: req.Content,
	})
	if err != nil {
		return nil, err
	}

	// Increment chapter count and persist the adopted record metadata.
	job.ChapterKeys++
	if job.StagePayload == nil || string(job.StagePayload) == "" || string(job.StagePayload) == "null" {
		job.StagePayload = []byte("{}")
	}
	var payload map[string]interface{}
	_ = json.Unmarshal(job.StagePayload, &payload)
	adopted := make([]map[string]interface{}, 0)
	if a, ok := payload["adopted"].([]interface{}); ok {
		for _, item := range a {
			if m, ok := item.(map[string]interface{}); ok {
				adopted = append(adopted, m)
			}
		}
	}
	adopted = append(adopted, map[string]interface{}{
		"chapter_key": req.ChapterKey,
		"chapter_id":  ch.ID,
		"title":       req.Title,
		"adopted_at":  time.Now().UTC(),
	})
	payload["adopted"] = adopted
	job.StagePayload = mustJSON(payload)
	s.repo.Update(ctx, job)
	return s.toResponse(job), nil
}

// AdvanceStage moves the state machine to the next stage (or holds at the
// author-confirmation boundary).
func (s *StoryService) AdvanceStage(ctx context.Context, userID, id int64) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	order := []string{
		model.StageIdea, model.StageOutline, model.StagePlanChapters,
		model.StageDraftChapter, model.StageVerify, model.StageFinalize, model.StageDone,
	}
	idx := -1
	for i, st := range order {
		if st == job.Stage {
			idx = i
			break
		}
	}
	if idx < 0 || idx >= len(order)-1 {
		job.Status = model.StoryJobDone
		job.Progress = job.TotalSteps
		job.Result = mustJSON(map[string]interface{}{
			"chapter_keys": job.ChapterKeys,
			"completed_at": time.Now().UTC(),
		})
		s.repo.Update(ctx, job)
		return s.toResponse(job), nil
	}
	job.Stage = order[idx+1]
	job.Progress = idx + 1
	job.Status = model.StoryJobPending
	s.repo.Update(ctx, job)
	return s.toResponse(job), nil
}

// stageToScene maps a job stage to the agent scene name and the user prompt
// that drives generation for that stage.
func (s *StoryService) stageToScene(job *model.StoryJob, instruction string) (string, string) {
	switch job.Stage {
	case model.StageIdea, model.StageOutline:
		return "outline", s.prompt("请基于创意展开完整大纲（幕/节点级情节规划）。", job, instruction)
	case model.StagePlanChapters:
		return "outline", s.prompt("请将大纲节点规划为章节清单（每章标题+一句话梗概）。", job, instruction)
	case model.StageDraftChapter:
		return "chapter", s.prompt("请完整撰写本章正文。", job, instruction)
	default:
		return "summary", s.prompt("请生成本阶段的摘要/评价。", job, instruction)
	}
}

// prompt builds a stage prompt embedding the job title/logline.
func (s *StoryService) prompt(base string, job *model.StoryJob, instruction string) string {
	b := fmt.Sprintf("作品：《%s》\n创意：%s\n任务：%s", job.Title, job.Logline, base)
	if instruction != "" {
		b += "\n补充要求：" + instruction
	}
	return b
}

// ownedNovel verifies the novel belongs to the user.
func (s *StoryService) ownedNovel(ctx context.Context, userID, novelID int64) error {
	if s.novelRepo == nil {
		return nil
	}
	novel, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		return err
	}
	if novel == nil {
		return ErrNotFound
	}
	return nil
}

// postAI posts payload to an ai-service path and decodes the JSON body.
func (s *StoryService) postAI(ctx context.Context, path string, payload interface{}, out interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.aiServiceURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create upstream request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("AI service error (%d): %s", resp.StatusCode, string(raw))
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode AI response: %w", err)
	}
	return nil
}

// toResponse maps a job to the response DTO.
func (s *StoryService) toResponse(j *model.StoryJob) *dto.StoryJobResponse {
	return &dto.StoryJobResponse{
		ID:            j.ID,
		NovelID:       j.NovelID,
		Title:         j.Title,
		Logline:       j.Logline,
		Stage:         j.Stage,
		Status:        j.Status,
		Progress:      j.Progress,
		TotalSteps:    j.TotalSteps,
		StagePayload:  json.RawMessage(j.StagePayload),
		Result:        json.RawMessage(j.Result),
		LastError:     j.LastError,
		ChapterKeys:   j.ChapterKeys,
		CreatedAt:     j.CreatedAt,
		UpdatedAt:     j.UpdatedAt,
	}
}

// mustJSON marshals a value to JSON, returning "{}" on failure.
func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
