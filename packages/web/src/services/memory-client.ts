import apiClient from './api-client';
import type { MemoryItem } from '@/stores/memory-store';

/**
 * 作品记忆服务（后端预留对接）
 *
 * 预留端点契约：
 *   GET  /novels/:id/memory      → { items: MemoryItem[] }
 *   PUT  /novels/:id/memory      req: { items: MemoryItem[] }
 *
 * 后端未就绪时由 store 层降级为 localStorage 本地保存。
 */

export async function fetchMemory(novelId: number): Promise<MemoryItem[]> {
  const data = (await apiClient.get(`/novels/${novelId}/memory`)) as unknown as {
    items?: MemoryItem[];
  };
  return data?.items ?? (Array.isArray(data) ? (data as unknown as MemoryItem[]) : []);
}

export async function saveMemory(novelId: number, items: MemoryItem[]): Promise<void> {
  await apiClient.put(`/novels/${novelId}/memory`, { items });
}
