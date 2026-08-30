import apiClient from './api-client';
import type {
  PublicWork,
  PublicChapterSummary,
  PublicChapter,
  PublishedWork,
  PublishedChapter,
  ReadingProgress,
} from '@/types/published';

/**
 * 公开阅读 API 客户端（业务方案 v3 E4，施工任务 A18/A19）
 *
 * 匿名读端点（/api/v1/read/works、/read/chapters）无需 token；api-client
 * 的请求拦截器是条件注入 token（存在才注入），未登录读者调用安全。
 * 进度与追更需登录，挂在 /api/v1/read/progress 与 /read/follows，由
 * api 组的 authMiddleware 保护。
 */

export async function getPublicWork(slug: string): Promise<PublicWork> {
  return (await apiClient.get(`/read/works/${slug}`)) as unknown as PublicWork;
}

export async function listPublicChapters(slug: string): Promise<PublicChapterSummary[]> {
  const data = (await apiClient.get(
    `/read/works/${slug}/chapters`,
  )) as unknown as PublicChapterSummary[];
  return data ?? [];
}

export async function getPublicChapter(pid: number): Promise<PublicChapter> {
  return (await apiClient.get(`/read/chapters/${pid}`)) as unknown as PublicChapter;
}

// ── 作者侧发布 API（A17）─────────────────────────────────────────────────

export async function listMyPublishedWorks(): Promise<PublishedWork[]> {
  const data = (await apiClient.get('/publish/works')) as unknown as PublishedWork[];
  return data ?? [];
}

export async function publishWork(payload: {
  novel_id: number;
  title: string;
  synopsis?: string;
  cover_url?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  slug?: string;
}): Promise<PublishedWork> {
  return (await apiClient.post('/publish/works', payload)) as unknown as PublishedWork;
}

export async function updatePublishedWork(
  wid: number,
  payload: Partial<{
    title: string;
    synopsis: string;
    cover_url: string;
    visibility: 'public' | 'unlisted' | 'private';
  }>,
): Promise<PublishedWork> {
  return (await apiClient.put(`/publish/works/${wid}`, payload)) as unknown as PublishedWork;
}

export async function unpublishWork(wid: number): Promise<void> {
  await apiClient.delete(`/publish/works/${wid}`);
}

export async function publishChapter(
  wid: number,
  payload: { chapter_id: number; scheduled_at?: string },
): Promise<PublishedChapter> {
  return (await apiClient.post(
    `/publish/works/${wid}/chapters`,
    payload,
  )) as unknown as PublishedChapter;
}

export async function unpublishChapter(pid: number): Promise<void> {
  await apiClient.delete(`/publish/chapters/${pid}`);
}

// ── 阅读进度与追更（需登录）─────────────────────────────────────────────

export async function getReadingProgress(workId: number): Promise<ReadingProgress | null> {
  const data = (await apiClient.get(
    `/read/progress?work_id=${workId}`,
  )) as unknown as Partial<ReadingProgress> | null;
  // 后端无进度时返回空对象
  if (!data || !data.work_id) return null;
  return data as ReadingProgress;
}

export async function upsertReadingProgress(
  workId: number,
  chapterId: number,
  position: number,
): Promise<void> {
  await apiClient.put('/read/progress', {
    work_id: workId,
    chapter_id: chapterId,
    position,
  });
}

export async function followWork(workId: number, notify = true): Promise<void> {
  await apiClient.post('/read/follows', { work_id: workId, notify });
}

export async function unfollowWork(workId: number): Promise<void> {
  await apiClient.delete(`/read/follows/${workId}`);
}
