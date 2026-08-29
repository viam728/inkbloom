import apiClient from './api-client';

/**
 * 伏笔台账服务（业务方案 v3 E2，施工任务 A12/A13）
 *
 * 端点契约：
 *   GET    /novels/:id/foreshadows          → 全部伏笔
 *   GET    /novels/:id/foreshadows/pending  → 待回收（planted/reminded），按紧急度排序
 *   POST   /novels/:id/foreshadows          → 手工登记
 *   POST   /novels/:id/foreshadows/detect   → AI 检测本章伏笔（**只返回候选，不落库**）
 *   POST   /novels/:id/foreshadows/scan     → 检测哪些伏笔被本章回收（自动置 resolved）
 *   PUT    /foreshadows/:fid                → 改状态
 *   DELETE /foreshadows/:fid                → 删除
 */

export type ForeshadowStatus = 'planted' | 'reminded' | 'resolved' | 'abandoned';

export interface Foreshadow {
  id: number;
  novel_id: number;
  description: string;
  plant_chapter_id?: number;
  plant_anchor?: string;
  expect_chapter?: number;
  status: ForeshadowStatus;
  resolve_chapter_id?: number;
  source: 'manual' | 'ai';
  plant_chapter_title?: string;
  resolve_chapter_title?: string;
  created_at: string;
  updated_at: string;
}

export interface ForeshadowCandidate {
  description: string;
  anchor: string;
  expect_chapter?: number;
  confidence: number;
  reason?: string;
}

export interface DetectResult {
  candidates: ForeshadowCandidate[];
  /** AI 服务不可用：此时空列表代表"没检测成"，而非"没有伏笔" */
  degraded: boolean;
}

export interface ScanResult {
  resolved: Foreshadow[];
  scanned: number;
  degraded: boolean;
}

export async function listForeshadows(novelId: number): Promise<Foreshadow[]> {
  const data = (await apiClient.get(
    `/novels/${novelId}/foreshadows`,
  )) as unknown as Foreshadow[];
  return data ?? [];
}

export async function createForeshadow(
  novelId: number,
  payload: {
    description: string;
    plant_chapter_id?: number;
    plant_anchor?: string;
    expect_chapter?: number;
    source?: 'manual' | 'ai';
  },
): Promise<Foreshadow> {
  return (await apiClient.post(`/novels/${novelId}/foreshadows`, payload)) as unknown as Foreshadow;
}

export async function updateForeshadowStatus(
  id: number,
  status: ForeshadowStatus,
  resolveChapterId?: number,
): Promise<Foreshadow> {
  return (await apiClient.put(`/foreshadows/${id}`, {
    status,
    ...(resolveChapterId !== undefined ? { resolve_chapter_id: resolveChapterId } : {}),
  })) as unknown as Foreshadow;
}

export async function deleteForeshadow(id: number): Promise<void> {
  await apiClient.delete(`/foreshadows/${id}`);
}

/** AI 检测埋设：返回候选待人工确认，绝不自动落库 */
export async function detectPlants(
  novelId: number,
  chapterId: number,
): Promise<DetectResult> {
  const data = (await apiClient.post(`/novels/${novelId}/foreshadows/detect`, {
    chapter_id: chapterId,
  })) as unknown as DetectResult;
  return { candidates: data?.candidates ?? [], degraded: !!data?.degraded };
}

/** 检测本章回收了哪些伏笔；命中的会由服务端自动置为 resolved */
export async function scanChapter(
  novelId: number,
  chapterId: number,
): Promise<ScanResult> {
  const data = (await apiClient.post(`/novels/${novelId}/foreshadows/scan`, {
    chapter_id: chapterId,
  })) as unknown as ScanResult;
  return {
    resolved: data?.resolved ?? [],
    scanned: data?.scanned ?? 0,
    degraded: !!data?.degraded,
  };
}
