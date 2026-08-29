import apiClient from './api-client';

/**
 * 章节版本历史服务（业务方案 v3 E1）
 *
 * 端点契约：
 *   GET    /chapters/:id/versions                → 摘要列表（不含正文）
 *   GET    /chapters/:id/versions/:vid           → 单条含正文
 *   POST   /chapters/:id/versions                → 手动打点 { kind, label }
 *   POST   /chapters/:id/versions/:vid/restore   → 回滚，返回回滚前的检查点
 */

export type ChapterVersionKind = 'auto' | 'milestone' | 'ai_rewrite' | 'rollback' | 'import';

export interface ChapterVersionSummary {
  id: number;
  chapter_id: number;
  novel_id: number;
  title: string;
  word_count: number;
  kind: ChapterVersionKind;
  label?: string;
  content_hash: string;
  created_at: string;
}

export interface ChapterVersionDetail extends ChapterVersionSummary {
  content?: string;
  content_json?: unknown;
}

/** 保留策略（A07）：自动快照的存活时长；max_days 为 0 表示不限期 */
export interface RetentionInfo {
  keep_count: number;
  max_days: number;
  tier: 'free' | 'paid' | 'unlimited';
}

export interface VersionListResponse {
  versions: ChapterVersionSummary[];
  total: number;
  limit: number;
  offset: number;
  retention?: RetentionInfo;
}

/** 拉取章节当前正文（回滚后用于刷新编辑器草稿） */
export async function fetchChapterContent(chapterId: number): Promise<string> {
  const data = (await apiClient.get(`/chapters/${chapterId}/content`)) as unknown as {
    content?: string;
  };
  return data?.content ?? '';
}

export async function listChapterVersions(
  chapterId: number,
  limit = 50,
  offset = 0,
): Promise<VersionListResponse> {
  const data = (await apiClient.get(
    `/chapters/${chapterId}/versions?limit=${limit}&offset=${offset}`,
  )) as unknown as VersionListResponse;
  return data ?? { versions: [], total: 0, limit, offset };
}

export async function getChapterVersion(
  chapterId: number,
  versionId: number,
): Promise<ChapterVersionDetail> {
  return (await apiClient.get(
    `/chapters/${chapterId}/versions/${versionId}`,
  )) as unknown as ChapterVersionDetail;
}

/**
 * 打一个检查点。
 *
 * kind 只允许 milestone（手动存档）或 ai_rewrite（AI 改写前存点）。
 * auto 由服务端在写入时自动生成，前端不可指定。
 */
export async function snapshotChapter(
  chapterId: number,
  kind: 'milestone' | 'ai_rewrite' = 'milestone',
  label?: string,
): Promise<ChapterVersionSummary | null> {
  try {
    return (await apiClient.post(`/chapters/${chapterId}/versions`, {
      kind,
      label,
    })) as unknown as ChapterVersionSummary;
  } catch {
    // 存点失败绝不阻断改写/保存主流程（施工任务 A04 验收标准）
    return null;
  }
}

export async function restoreChapterVersion(
  chapterId: number,
  versionId: number,
): Promise<ChapterVersionSummary> {
  return (await apiClient.post(
    `/chapters/${chapterId}/versions/${versionId}/restore`,
  )) as unknown as ChapterVersionSummary;
}
