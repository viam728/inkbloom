import { create } from 'zustand';
import {
  listTrash,
  restoreTrash,
  purgeTrash,
  type TrashItem,
} from '@/services/trash-client';

/** 回收站状态：按作品维度的列表 + 恢复/彻底删除动作。列表不持久化。 */
interface TrashState {
  byNovel: Record<number, TrashItem[]>;
  loading: boolean;
  /** 恢复中的记录 id（按钮级 loading） */
  restoringId: number | null;
  load: (novelId: number) => Promise<void>;
  restore: (novelId: number, trashId: number, targetActId: string) => Promise<void>;
  purge: (novelId: number, trashId: number) => Promise<void>;
}

export const useTrashStore = create<TrashState>((set) => ({
  byNovel: {},
  loading: false,
  restoringId: null,

  load: async (novelId) => {
    set({ loading: true });
    try {
      const items = await listTrash(novelId);
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: items } }));
    } catch {
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: s.byNovel[novelId] ?? [] } }));
    } finally {
      set({ loading: false });
    }
  },

  restore: async (novelId, trashId, targetActId) => {
    set({ restoringId: trashId });
    try {
      await restoreTrash(novelId, trashId, targetActId);
      // 出桶 + 本地列表同步
      set((s) => ({
        byNovel: {
          ...s.byNovel,
          [novelId]: (s.byNovel[novelId] ?? []).filter((i) => i.id !== trashId),
        },
      }));
    } finally {
      set({ restoringId: null });
    }
  },

  purge: async (novelId, trashId) => {
    set({ restoringId: trashId });
    try {
      await purgeTrash(novelId, trashId);
      set((s) => ({
        byNovel: {
          ...s.byNovel,
          [novelId]: (s.byNovel[novelId] ?? []).filter((i) => i.id !== trashId),
        },
      }));
    } finally {
      set({ restoringId: null });
    }
  },
}));
