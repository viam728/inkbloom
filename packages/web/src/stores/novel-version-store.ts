import { create } from 'zustand';
import {
  listNovelVersions,
  restoreNovelVersion,
  snapshotNovel,
  type NovelVersionSummary,
  type RestoreMode,
} from '@/services/novel-version-client';
import { track } from '@/services/analytics';

/**
 * 整本里程碑快照状态（Agent safety work Q3）
 *
 * 只缓存"当前查看作品"的版本列表；切换作品即整体重置。
 */

interface NovelVersionState {
  novelId: number | null;
  versions: NovelVersionSummary[];
  total: number;
  loading: boolean;
  restoring: boolean;
  snapshotting: boolean;
  error: string | null;

  load: (novelId: number) => Promise<void>;
  /** 手动存整本里程碑；返回新版本 id，失败返回 null */
  snapshot: (novelId: number, label?: string) => Promise<number | null>;
  /** 还原整本；返回还原结果，失败返回 null */
  restore: (novelId: number, versionId: number, mode: RestoreMode) => Promise<boolean>;
  reset: () => void;
}

export const useNovelVersionStore = create<NovelVersionState>((set, get) => ({
  novelId: null,
  versions: [],
  total: 0,
  loading: false,
  restoring: false,
  snapshotting: false,
  error: null,

  load: async (novelId) => {
    set({ loading: true, error: null });
    try {
      const res = await listNovelVersions(novelId);
      set({
        novelId,
        versions: res.versions,
        total: res.total,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : '整本版本历史加载失败',
      });
    }
  },

  snapshot: async (novelId, label) => {
    set({ snapshotting: true, error: null });
    try {
      const v = await snapshotNovel(novelId, label);
      if (v) await get().load(novelId);
      set({ snapshotting: false });
      return v?.id ?? null;
    } catch (e) {
      set({
        snapshotting: false,
        error: e instanceof Error ? e.message : '存里程碑失败',
      });
      return null;
    }
  },

  restore: async (novelId, versionId, mode) => {
    set({ restoring: true, error: null });
    const target = get().versions.find((v) => v.id === versionId);
    const startedAt = Date.now();
    try {
      await restoreNovelVersion(novelId, versionId, mode);
      // 还原会写一条新的 rollback 版本，列表需整体刷新
      await get().load(novelId);
      set({ restoring: false });
      track('novel_version_restored', {
        mode,
        kind: target?.kind ?? 'unknown',
        age_seconds: target
          ? Math.round((startedAt - new Date(target.created_at).getTime()) / 1000)
          : -1,
      });
      return true;
    } catch (e) {
      set({
        restoring: false,
        error: e instanceof Error ? e.message : '还原失败',
      });
      return false;
    }
  },

  reset: () =>
    set({
      novelId: null,
      versions: [],
      total: 0,
      loading: false,
      restoring: false,
      snapshotting: false,
      error: null,
    }),
}));