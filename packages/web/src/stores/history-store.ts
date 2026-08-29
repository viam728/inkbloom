import { create } from 'zustand';
import {
  listChapterVersions,
  restoreChapterVersion,
  snapshotChapter,
  type ChapterVersionSummary,
  type RetentionInfo,
} from '@/services/history-client';
import { track } from '@/services/analytics';

/**
 * 章节版本历史状态（业务方案 v3 E1，施工任务 A06）
 *
 * 只缓存"当前查看章节"的版本列表：切换章节即整体重置，避免多标签页
 * 场景下相互污染。
 */
interface HistoryState {
  /** 列表归属的章节；与请求的章节不一致时视为脏数据 */
  chapterId: number | null;
  versions: ChapterVersionSummary[];
  total: number;
  /** 当前档位的保留策略（A07），用于面板提示 */
  retention: RetentionInfo | null;
  loading: boolean;
  restoring: boolean;
  snapshotting: boolean;
  error: string | null;

  load: (chapterId: number) => Promise<void>;
  /** 回滚到指定版本；返回 true 表示正文已变更，宿主需重新拉取章节内容 */
  restore: (chapterId: number, versionId: number) => Promise<boolean>;
  /** 手动存档；返回新版本 id，失败返回 null */
  snapshot: (chapterId: number, label?: string) => Promise<number | null>;
  reset: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  chapterId: null,
  versions: [],
  total: 0,
  retention: null,
  loading: false,
  restoring: false,
  snapshotting: false,
  error: null,

  load: async (chapterId) => {
    set({ loading: true, error: null });
    try {
      const res = await listChapterVersions(chapterId);
      set({
        chapterId,
        versions: res.versions,
        total: res.total,
        retention: res.retention ?? null,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : '版本历史加载失败',
      });
    }
  },

  restore: async (chapterId, versionId) => {
    set({ restoring: true, error: null });
    const target = get().versions.find((v) => v.id === versionId);
    const startedAt = Date.now();
    try {
      await restoreChapterVersion(chapterId, versionId);
      // 回滚会产生一条新的 rollback 版本，列表需整体刷新
      await get().load(chapterId);
      set({ restoring: false });
      // 埋点：回滚率衡量版本历史的真实价值（附录 B）。props 只含枚举与时长。
      track('version_restored', {
        kind: target?.kind ?? 'unknown',
        age_seconds: target
          ? Math.round((startedAt - new Date(target.created_at).getTime()) / 1000)
          : -1,
      });
      return true;
    } catch (e) {
      set({
        restoring: false,
        error: e instanceof Error ? e.message : '回滚失败',
      });
      return false;
    }
  },

  snapshot: async (chapterId, label) => {
    set({ snapshotting: true, error: null });
    try {
      const v = await snapshotChapter(chapterId, 'milestone', label);
      if (v) await get().load(chapterId);
      set({ snapshotting: false });
      return v?.id ?? null;
    } catch (e) {
      set({
        snapshotting: false,
        error: e instanceof Error ? e.message : '存档失败',
      });
      return null;
    }
  },

  reset: () =>
    set({
      chapterId: null,
      versions: [],
      total: 0,
      retention: null,
      loading: false,
      restoring: false,
      snapshotting: false,
      error: null,
    }),
}));
