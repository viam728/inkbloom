import { create } from 'zustand';
import {
  listForeshadows,
  createForeshadow,
  updateForeshadowStatus,
  deleteForeshadow,
  detectPlants,
  scanChapter,
  type Foreshadow,
  type ForeshadowCandidate,
  type ForeshadowStatus,
} from '@/services/foreshadow-client';

/**
 * 伏笔台账状态（业务方案 v3 E2，施工任务 A13）
 *
 * 只缓存"当前作品"的伏笔；切换作品即整体重置，避免串味。
 */
interface ForeshadowState {
  novelId: number | null;
  items: Foreshadow[];
  loading: boolean;
  /** AI 检测中（埋设候选） */
  detecting: boolean;
  /** AI 回收扫描中 */
  scanning: boolean;
  /** 最近一次检测到的候选，等待作者逐条确认 */
  candidates: ForeshadowCandidate[];
  /** AI 不可用：候选为空是因为没检测成，而不是没找到 */
  degraded: boolean;
  error: string | null;

  load: (novelId: number) => Promise<void>;
  create: (
    novelId: number,
    payload: { description: string; plant_chapter_id?: number; plant_anchor?: string; expect_chapter?: number },
  ) => Promise<boolean>;
  /** 确认登记某条候选（候选来自 AI 检测，落库时标 source=ai） */
  adopt: (novelId: number, candidate: ForeshadowCandidate, chapterId?: number) => Promise<boolean>;
  setStatus: (novelId: number, id: number, status: ForeshadowStatus, resolveChapterId?: number) => Promise<boolean>;
  remove: (novelId: number, id: number) => Promise<boolean>;
  /** AI 检测本章埋设的伏笔候选（不落库） */
  detect: (novelId: number, chapterId: number) => Promise<void>;
  /** AI 检测本章回收了哪些伏笔（命中自动 resolved） */
  scan: (novelId: number, chapterId: number) => Promise<number>;
  clearCandidates: () => void;
  reset: () => void;
}

export const useForeshadowStore = create<ForeshadowState>((set, get) => ({
  novelId: null,
  items: [],
  loading: false,
  detecting: false,
  scanning: false,
  candidates: [],
  degraded: false,
  error: null,

  load: async (novelId) => {
    set({ loading: true, error: null });
    try {
      const items = await listForeshadows(novelId);
      set({ novelId, items, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '伏笔加载失败' });
    }
  },

  create: async (novelId, payload) => {
    set({ error: null });
    try {
      await createForeshadow(novelId, payload);
      await get().load(novelId);
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '登记失败' });
      return false;
    }
  },

  adopt: async (novelId, candidate, chapterId) => {
    set({ error: null });
    try {
      await createForeshadow(novelId, {
        description: candidate.description,
        ...(chapterId !== undefined ? { plant_chapter_id: chapterId } : {}),
        plant_anchor: candidate.anchor,
        ...(candidate.expect_chapter !== undefined
          ? { expect_chapter: candidate.expect_chapter }
          : {}),
        source: 'ai',
      });
      // 登记后从候选列表移除
      set((s) => ({
        candidates: s.candidates.filter((c) => c.anchor !== candidate.anchor),
      }));
      await get().load(novelId);
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '登记失败' });
      return false;
    }
  },

  setStatus: async (novelId, id, status, resolveChapterId) => {
    set({ error: null });
    try {
      await updateForeshadowStatus(id, status, resolveChapterId);
      await get().load(novelId);
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '状态更新失败' });
      return false;
    }
  },

  remove: async (novelId, id) => {
    set({ error: null });
    try {
      await deleteForeshadow(id);
      await get().load(novelId);
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '删除失败' });
      return false;
    }
  },

  detect: async (novelId, chapterId) => {
    set({ detecting: true, error: null, candidates: [], degraded: false });
    try {
      const res = await detectPlants(novelId, chapterId);
      set({ candidates: res.candidates, degraded: res.degraded, detecting: false });
    } catch (e) {
      set({
        detecting: false,
        degraded: true,
        error: e instanceof Error ? e.message : '检测失败',
      });
    }
  },

  scan: async (novelId, chapterId) => {
    set({ scanning: true, error: null });
    try {
      const res = await scanChapter(novelId, chapterId);
      await get().load(novelId);
      set({ scanning: false, degraded: res.degraded });
      return res.resolved.length;
    } catch (e) {
      set({ scanning: false, error: e instanceof Error ? e.message : '扫描失败' });
      return 0;
    }
  },

  clearCandidates: () => set({ candidates: [], degraded: false }),
  reset: () =>
    set({
      novelId: null,
      items: [],
      loading: false,
      detecting: false,
      scanning: false,
      candidates: [],
      degraded: false,
      error: null,
    }),
}));
