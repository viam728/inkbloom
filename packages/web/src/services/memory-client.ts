import apiClient from './api-client';
import type { MemoryItem } from '@/stores/memory-store';

/**
 * 记忆服务（后端预留对接）
 *
 * 端点契约：
 *   GET  /novels/:id/memory      → { items: MemoryItem[], version: number }
 *   PUT  /novels/:id/memory      req: { items, version? } → { items, version }
 *   GET  /media/memory           → { items: MemoryItem[], version: number }
 *   PUT  /media/memory           req: { items, version? } → { items, version }
 *   409 = 版本冲突（其他端已更新，需重新拉取）
 *
 * 后端未就绪时由 store 层降级为 localStorage 本地保存。
 */

export interface MemorySyncResult {
  items: MemoryItem[];
  version: number;
}

/** 判断错误是否为后端 409 版本冲突（api-client 透传 axios 错误对象，status 位于 response.status） */
export function isConflictError(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 409;
}

export async function fetchMemory(novelId: number): Promise<MemorySyncResult> {
  const data = (await apiClient.get(`/novels/${novelId}/memory`)) as unknown as {
    items?: MemoryItem[];
    version?: number;
  };
  const items = data?.items ?? (Array.isArray(data) ? (data as unknown as MemoryItem[]) : []);
  return { items, version: data?.version ?? 0 };
}

export async function saveMemory(
  novelId: number,
  items: MemoryItem[],
  version?: number,
): Promise<MemorySyncResult> {
  const data = (await apiClient.put(`/novels/${novelId}/memory`, {
    items,
    ...(version !== undefined ? { version } : {}),
  })) as unknown as { items?: MemoryItem[]; version?: number };
  return { items: data?.items ?? items, version: data?.version ?? version ?? 0 };
}

export async function fetchMediaMemory(): Promise<MemorySyncResult> {
  const data = (await apiClient.get('/media/memory')) as unknown as {
    items?: MemoryItem[];
    version?: number;
  };
  const items = data?.items ?? (Array.isArray(data) ? (data as unknown as MemoryItem[]) : []);
  return { items, version: data?.version ?? 0 };
}

export async function saveMediaMemory(
  items: MemoryItem[],
  version?: number,
): Promise<MemorySyncResult> {
  const data = (await apiClient.put('/media/memory', {
    items,
    ...(version !== undefined ? { version } : {}),
  })) as unknown as { items?: MemoryItem[]; version?: number };
  return { items: data?.items ?? items, version: data?.version ?? version ?? 0 };
}
