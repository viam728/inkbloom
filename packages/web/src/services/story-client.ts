import apiClient from './api-client';

/**
 * Agent 全本创作流水线（story_jobs）客户端。
 *
 * 端点契约：
 *   POST   /story/jobs                    req: { novel_id, title, logline }      → StoryJob
 *   GET    /story/jobs/?novel_id=&page=   → { jobs, total, page, page_size }
 *   GET    /story/jobs/:id                → StoryJob
 *   DELETE /story/jobs/:id                → ok
 *   POST   /story/jobs/:id/generate       req: { instruction? }                    → StoryJob
 *   POST   /story/jobs/:id/chapters/adopt req: { chapter_key, title, content }     → StoryJob
 *   POST   /story/jobs/:id/advance        → StoryJob
 */

export type StoryStage =
  | 'idea'
  | 'outline'
  | 'plan_chapters'
  | 'draft_chapter'
  | 'verify'
  | 'finalize'
  | 'done';

export type StoryStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

export interface AdoptedChapter {
  chapter_key?: string;
  chapter_id?: number;
  title?: string;
  adopted_at?: string;
}

export interface StoryStagePayload {
  scene?: string;
  content?: string;
  generated?: string;
  adopted?: AdoptedChapter[];
  [key: string]: unknown;
}

export interface StoryJob {
  id: number;
  novel_id: number;
  title: string;
  logline: string;
  stage: StoryStage;
  status: StoryStatus;
  progress: number;
  total_steps: number;
  stage_payload: StoryStagePayload;
  result: Record<string, unknown> | null;
  last_error: string;
  chapter_keys: number;
  created_at: string;
  updated_at: string;
}

export interface StoryJobsList {
  jobs: StoryJob[];
  total: number;
  page: number;
  page_size: number;
}

export interface CreateStoryJobRequest {
  novel_id: number;
  title: string;
  logline: string;
}

export async function createStoryJob(req: CreateStoryJobRequest): Promise<StoryJob> {
  const data = (await apiClient.post('/story/jobs', req)) as unknown as StoryJob;
  return data;
}

export async function listStoryJobs(opts: { novelId?: number; page?: number; pageSize?: number }): Promise<StoryJobsList> {
  const params: Record<string, unknown> = {};
  if (opts.novelId) params.novel_id = opts.novelId;
  if (opts.page) params.page = opts.page;
  if (opts.pageSize) params.page_size = opts.pageSize;
  const data = (await apiClient.get('/story/jobs', { params })) as unknown as StoryJobsList;
  return data;
}

export async function getStoryJob(id: number): Promise<StoryJob> {
  const data = (await apiClient.get(`/story/jobs/${id}`)) as unknown as StoryJob;
  return data;
}

export async function deleteStoryJob(id: number): Promise<void> {
  await apiClient.delete(`/story/jobs/${id}`);
}

export async function generateStoryStage(id: number, instruction?: string): Promise<StoryJob> {
  const data = (await apiClient.post(`/story/jobs/${id}/generate`, { instruction })) as unknown as StoryJob;
  return data;
}

export async function adoptStoryChapter(id: number, req: { chapter_key: string; title: string; content: string }): Promise<StoryJob> {
  const data = (await apiClient.post(`/story/jobs/${id}/chapters/adopt`, req)) as unknown as StoryJob;
  return data;
}

export async function advanceStoryStage(id: number): Promise<StoryJob> {
  const data = (await apiClient.post(`/story/jobs/${id}/advance`, {})) as unknown as StoryJob;
  return data;
}

/** 阶段中文标签（供工作流面板渲染） */
export const STORY_STAGE_LABELS: Record<StoryStage, string> = {
  idea: '创意',
  outline: '大纲',
  plan_chapters: '分章',
  draft_chapter: '成稿',
  verify: '校验',
  finalize: '定稿',
  done: '完成',
};
