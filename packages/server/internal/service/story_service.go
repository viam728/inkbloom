package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
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
	knowledgeSvc   *KnowledgeService   // optional: auto-extract into knowledge graph
	foreshadowSvc  *ForeshadowService  // optional: auto-detect planted threads
	aiServiceURL   string
	httpClient     *http.Client
	logger         *zap.Logger

	// jobLocks serialises read-modify-write on a single job (adopt path).
	// Lazy per-job mutexes guarded by jobLocksMu; single-instance only —
	// multi-instance deployment would need a DB constraint or distributed
	// lock (out of scope for the current phase).
	jobLocksMu sync.Mutex
	jobLocks   map[int64]*sync.Mutex
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
		jobLocks:     make(map[int64]*sync.Mutex),
	}
}

// lockJob acquires the per-job mutex, creating it lazily on first use.
func (s *StoryService) lockJob(id int64) {
	s.jobLocksMu.Lock()
	mu, ok := s.jobLocks[id]
	if !ok {
		mu = &sync.Mutex{}
		s.jobLocks[id] = mu
	}
	s.jobLocksMu.Unlock()
	mu.Lock()
}

// unlockJob releases the per-job mutex acquired by lockJob.
func (s *StoryService) unlockJob(id int64) {
	s.jobLocksMu.Lock()
	mu := s.jobLocks[id]
	s.jobLocksMu.Unlock()
	if mu != nil {
		mu.Unlock()
	}
}

// WithClosedLoop wires the optional knowledge/foreshadow services so that
// adopting a chapter automatically extracts entities into the knowledge
// graph and detects planted foreshadow threads (plan P2-b). Without them,
// adoption only writes the chapter body.
func (s *StoryService) WithClosedLoop(ks *KnowledgeService, fs *ForeshadowService) *StoryService {
	s.knowledgeSvc = ks
	s.foreshadowSvc = fs
	return s
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
		Config:       defaultJobConfig(req.Config),
	}
	if err := s.repo.Create(ctx, job); err != nil {
		return nil, err
	}
	return s.toResponse(job), nil
}

// defaultJobConfig normalizes the author's generation settings, filling in
// defaults for any slider the client omitted.
func defaultJobConfig(raw json.RawMessage) []byte {
	cfg := map[string]interface{}{
		"chapter_count":     10,
		"words_per_chapter": 2000,
		"style":             "",
		"auto_settle":       true,
	}
	if len(raw) > 0 {
		var user map[string]interface{}
		if json.Unmarshal(raw, &user) == nil {
			for k, v := range user {
				cfg[k] = v
			}
		}
	}
	return mustJSON(cfg)
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
// the author confirms via Adopt*. The verify stage is special: it runs a
// consistency check against the novel's knowledge graph instead of an LLM
// scene (plan P2-c closed-loop).
func (s *StoryService) GenerateStage(ctx context.Context, userID, id int64, instruction string) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}

	job.Status = model.StoryJobRunning

	// Verify stage: run the existing consistency checker against the latest
	// adopted chapter(s), no LLM call.
	if job.Stage == model.StageVerify {
		return s.runVerifyStage(ctx, job)
	}

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
//
// Idempotent on chapter_key: replaying an already-adopted key (double click,
// retry, old-panel replay) returns the current job unchanged instead of
// creating a duplicate chapter. An empty key is generated server-side as
// ch-{ChapterKeys+1}. Concurrent adopts of the same job are serialised by a
// per-job mutex so the read-modify-write on StagePayload/ChapterKeys cannot
// interleave.
func (s *StoryService) AdoptChapter(ctx context.Context, userID, id int64, req *dto.AdoptChapterRequest) (*dto.StoryJobResponse, error) {
	s.lockJob(id)
	defer s.unlockJob(id)

	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}

	// Parse the adopted records up front (moved from the write path below so
	// the idempotency check runs before any chapter is created).
	adopted := parseAdopted(job.StagePayload)

	// Key normalisation: an empty key becomes the next sequential one.
	// Generation happens inside the per-job critical section and the
	// generated key is immediately checked against existing records, so
	// concurrent empty-key requests cannot collide.
	key := req.ChapterKey
	if key == "" {
		key = fmt.Sprintf("ch-%d", job.ChapterKeys+1)
	}

	// Idempotency hit: the key was already adopted — no new chapter, no
	// counter increment, HTTP 200 with the current job state.
	for _, m := range adopted {
		if m["chapter_key"] == key {
			return s.toResponse(job), nil
		}
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
	adopted = append(adopted, map[string]interface{}{
		"chapter_key": key,
		"chapter_id":  ch.ID,
		"title":       req.Title,
		"adopted_at":  time.Now().UTC(),
	})
	payload["adopted"] = adopted

	// Closed-loop binding (plan P2-b): after the author adopts a chapter,
	// automatically extract its entities into the knowledge graph and detect
	// planted foreshadow threads. Failures here are best-effort and never
	// block the adoption — the chapter is already written.
	extracted, candidates := s.settleChapter(ctx, userID, job.NovelID, ch.ID, req.Content)
	if extracted > 0 || len(candidates) > 0 {
		payload["settled"] = map[string]interface{}{
			"knowledge_nodes":      extracted,
			"foreshadow_candidates": candidates,
		}
	}

	job.StagePayload = mustJSON(payload)
	s.repo.Update(ctx, job)
	return s.toResponse(job), nil
}

// parseAdopted extracts the adopted-chapter records from a job's
// StagePayload. Never fails: a malformed/empty payload yields an empty slice.
func parseAdopted(raw []byte) []map[string]interface{} {
	adopted := make([]map[string]interface{}, 0)
	if len(raw) == 0 || string(raw) == "null" {
		return adopted
	}
	var payload map[string]interface{}
	if json.Unmarshal(raw, &payload) != nil {
		return adopted
	}
	if a, ok := payload["adopted"].([]interface{}); ok {
		for _, item := range a {
			if m, ok := item.(map[string]interface{}); ok {
				adopted = append(adopted, m)
			}
		}
	}
	return adopted
}

// runVerifyStage checks the latest adopted chapter(s) for consistency against
// the novel's knowledge graph (no LLM call) and stores the report in
// StagePayload for the workflow panel to render.
func (s *StoryService) runVerifyStage(ctx context.Context, job *model.StoryJob) (*dto.StoryJobResponse, error) {
	chapters, err := s.chapterRepo.ListByNovelID(ctx, job.UserID, job.NovelID)
	if err != nil {
		job.Status = model.StoryJobFailed
		job.LastError = err.Error()
		_ = s.repo.Update(ctx, job)
		return s.toResponse(job), err
	}

	issues := []interface{}{}
	degraded := false
	if s.knowledgeSvc != nil && len(chapters) > 0 {
		// Check the most recently written chapter(s) — the tail is what a
		// verify pass should focus on.
		last := chapters[len(chapters)-1]
		var text string
		if last.Content != nil {
			text = *last.Content
		}
		found, cerr := s.knowledgeSvc.CheckConsistency(ctx, job.UserID, job.NovelID, last.ID, text)
		if cerr != nil {
			s.logger.Warn("verify stage: consistency check failed", zap.Int64("chapter_id", last.ID), zap.Error(cerr))
			degraded = true
		} else {
			for _, it := range found {
				issues = append(issues, it)
			}
		}
	} else {
		degraded = true
	}

	job.StagePayload = mustJSON(map[string]interface{}{
		"scene":       model.StageVerify,
		"issues":      issues,
		"issue_count": len(issues),
		"degraded":    degraded,
		"generated":   time.Now().UTC(),
	})
	job.LastError = ""
	job.Status = model.StoryJobPending
	s.repo.Update(ctx, job)
	return s.toResponse(job), nil
}

// settleChapter runs the closed-loop binding for a freshly adopted chapter.
// Returns (knowledgeExtracted, foreshadowCandidates). Best-effort — errors
// are logged and swallowed so they never block adoption.
func (s *StoryService) settleChapter(ctx context.Context, userID, novelID, chapterID int64, content string) (int, []dto.ForeshadowCandidate) {
	nodes := 0
	candidates := []dto.ForeshadowCandidate{}
	if s.knowledgeSvc != nil {
		if err := s.knowledgeSvc.ExtractFromChapter(ctx, userID, novelID, chapterID, content); err != nil {
			s.logger.Warn("closed-loop: knowledge extraction failed",
				zap.Int64("chapter_id", chapterID), zap.Error(err))
		} else {
			nodes = 1 // coarse signal; precise count lives in the graph
		}
	}
	if s.foreshadowSvc != nil {
		resp, err := s.foreshadowSvc.DetectPlants(ctx, userID, novelID, chapterID)
		if err != nil {
			s.logger.Warn("closed-loop: foreshadow detection failed",
				zap.Int64("chapter_id", chapterID), zap.Error(err))
		} else if resp != nil && len(resp.Candidates) > 0 {
			candidates = resp.Candidates
		}
	}
	return nodes, candidates
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

// SetStage sets the job's stage directly (sliding selector, any order).
// This powers the draggable stage picker — the author can jump to any
// stage without stepping through the linear order.
func (s *StoryService) SetStage(ctx context.Context, userID, id int64, target string) (*dto.StoryJobResponse, error) {
	job, err := s.repo.GetByID(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	valid := map[string]bool{
		model.StageIdea:          true,
		model.StageOutline:       true,
		model.StagePlanChapters:  true,
		model.StageDraftChapter:  true,
		model.StageVerify:        true,
		model.StageFinalize:      true,
		model.StageDone:          true,
	}
	if !valid[target] {
		return nil, fmt.Errorf("invalid stage: %s", target)
	}
	order := []string{
		model.StageIdea, model.StageOutline, model.StagePlanChapters,
		model.StageDraftChapter, model.StageVerify, model.StageFinalize, model.StageDone,
	}
	// Progress = 1-based index in the canonical order (idea=0→progress shown as idx+1).
	for i, st := range order {
		if st == target {
			job.Progress = i
			break
		}
	}
	job.Stage = target
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

// prompt builds a stage prompt embedding the job title/logline + the
// author's generation settings (config) so the AI fills the system to spec.
func (s *StoryService) prompt(base string, job *model.StoryJob, instruction string) string {
	b := fmt.Sprintf("作品：《%s》\n创意：%s\n任务：%s", job.Title, job.Logline, base)
	if cfg := s.formatConfig(job.Config); cfg != "" {
		b += "\n\n【生成设置】\n" + cfg
	}
	if instruction != "" {
		b += "\n补充要求：" + instruction
	}
	return b
}

// formatConfig renders the author's generation settings into a compact
// directive block the LLM can obey (chapter count / words / style).
func (s *StoryService) formatConfig(raw []byte) string {
	var cfg map[string]interface{}
	if len(raw) == 0 || json.Unmarshal(raw, &cfg) != nil {
		return ""
	}
	var parts []string
	if v, ok := intVal(cfg["chapter_count"]); ok && v > 0 {
		parts = append(parts, fmt.Sprintf("全书规划 %d 章", v))
	}
	if v, ok := intVal(cfg["words_per_chapter"]); ok && v > 0 {
		parts = append(parts, fmt.Sprintf("每章约 %d 字", v))
	}
	if st, ok := cfg["style"].(string); ok && st != "" {
		parts = append(parts, fmt.Sprintf("文风：%s", st))
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "；")
}

// intVal coerces a JSON number (float64) into an int without panicking.
func intVal(v interface{}) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
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
		Config:        json.RawMessage(j.Config),
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
