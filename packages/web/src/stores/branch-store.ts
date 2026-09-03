import { create } from 'zustand';
import apiClient from '@/services/api-client';

/** 世界线分支节点（novel_branches 表） */
export interface BranchNode {
  id: number;
  novel_id: number;
  parent_id?: number | null;
  title: string;
  summary: string;
  source: 'ai' | 'user';
  chapter_id?: number | null;
  created_at: string;
}

interface BranchStore {
  byNovel: Record<number, BranchNode[]>;
  loading: boolean;
  /** 拉取某作品的全部分支节点（平铺，客户端组树） */
  load: (novelId: number) => Promise<void>;
  create: (
    novelId: number,
    payload: { parent_id?: number; title: string; summary: string; source?: 'ai' | 'user'; chapter_id?: number },
  ) => Promise<void>;
  update: (novelId: number, id: number, patch: { title?: string; summary?: string; chapter_id?: number }) => Promise<void>;
  remove: (novelId: number, id: number, subtree?: boolean) => Promise<void>;
}

export const useBranchStore = create<BranchStore>((set, get) => ({
  byNovel: {},
  loading: false,

  load: async (novelId) => {
    set({ loading: true });
    try {
      const data = (await apiClient.get(`/novels/${novelId}/branches`)) as unknown as BranchNode[];
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: data ?? [] } }));
    } catch {
      /* 后端不可用时保留现状（本地模式无分支能力） */
    } finally {
      set({ loading: false });
    }
  },

  create: async (novelId, payload) => {
    await apiClient.post(`/novels/${novelId}/branches`, {
      novel_id: novelId,
      parent_id: payload.parent_id || 0,
      title: payload.title,
      summary: payload.summary,
      source: payload.source ?? 'user',
      chapter_id: payload.chapter_id || 0,
    });
    await get().load(novelId);
  },

  update: async (novelId, id, patch) => {
    await apiClient.put(`/branches/${id}`, patch);
    await get().load(novelId);
  },

  remove: async (novelId, id, subtree) => {
    await apiClient.delete(`/branches/${id}${subtree ? '?subtree=1' : ''}`);
    await get().load(novelId);
  },
}));
