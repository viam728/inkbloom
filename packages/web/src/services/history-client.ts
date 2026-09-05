import apiClient from './api-client';

/**
 * 章节版本管理客户端（备忘录 L61 三态：草稿-发布-临时）
 *
 * 服务器保存两份文章：
 *   草稿 = chapters.content（工作区）；发布 = published_chapters.content
 *   （不可变副本，带 version_id → chapter_versions 发布快照指针）。
 *   GET    /chapters/:id/versions/summary            → 草稿/发布两态概要
 *   GET    /chapters/:id/versions/content?branch=X   → 某一态正文
 *   POST   /chapters/:id/versions/checkout/published → 回滚（发布正文拷回草稿）
 * 临时分支只存浏览器 localStorage（utils/temp-branch），服务器永不保存。
 */

/** 单个版本态概要 */
export interface VersionBranchSummary {
  exists: boolean;
  version_id?: number;
  word_count: number;
  updated_at: string;
}

/** 版本面板数据：草稿 + 发布（未发布时缺省） */
export interface VersionPanelSummary {
  draft: VersionBranchSummary;
  published?: VersionBranchSummary | null;
}

/** 拉取章节当前正文（回滚后用于刷新编辑器草稿） */
export async function fetchChapterContent(chapterId: number): Promise<string> {
  const data = (await apiClient.get(`/chapters/${chapterId}/content`)) as unknown as {
    content?: string;
  };
  return data?.content ?? '';
}

/** 草稿/发布两态概要（版本管理面板数据源） */
export async function getVersionSummary(chapterId: number): Promise<VersionPanelSummary> {
  return (await apiClient.get(
    `/chapters/${chapterId}/versions/summary`,
  )) as unknown as VersionPanelSummary;
}

/** 某一态正文：published 取发布不可变副本；draft 取工作区 */
export async function getVersionContent(
  chapterId: number,
  branch: 'draft' | 'published' = 'published',
): Promise<string> {
  const data = (await apiClient.get(
    `/chapters/${chapterId}/versions/content?branch=${branch}`,
  )) as unknown as { content?: string };
  return data?.content ?? '';
}

/** 回滚：把发布正文拷回草稿工作区（调用方先把当前草稿压入临时分支） */
export async function checkoutPublished(chapterId: number): Promise<string> {
  const data = (await apiClient.post(
    `/chapters/${chapterId}/versions/checkout/published`,
  )) as unknown as { content?: string };
  return data?.content ?? '';
}
