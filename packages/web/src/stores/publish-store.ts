import { create } from 'zustand';
import { listMyPublishedWorks, listPublishedChapters } from '@/services/reader-client';
import type { PublishedChapter, PublishedWork } from '@/types/published';

/**
 * 发布状态 store：已发布章节以 published_chapters 表为系统事实来源，
 * 前端各处（大纲节点卡 / 工具栏 / 发布弹窗）据此展示「已发布」并禁用手改。
 */
interface NovelPublishState {
  work: PublishedWork | null;
  chapters: PublishedChapter[];
}

interface PublishStore {
  byNovel: Record<number, NovelPublishState>;
  loading: boolean;
  /** 拉取某作品的发布状态（work + 已发布章节），失败静默降级为未发布 */
  load: (novelId: number) => Promise<void>;
  /** 发布成功后：本地并入已发布集合并回源校准 */
  markPublished: (novelId: number, chapters: PublishedChapter[]) => Promise<void>;
  /** 取消发布后：本地移除并回源校准 */
  markUnpublished: (novelId: number, chapterId: number) => Promise<void>;
  clear: () => void;
}

export const usePublishStore = create<PublishStore>((set, get) => ({
  byNovel: {},
  loading: false,

  load: async (novelId) => {
    set({ loading: true });
    try {
      const works = await listMyPublishedWorks();
      const work = works.find((w) => w.novel_id === novelId) ?? null;
      const chapters = work ? await listPublishedChapters(work.id) : [];
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: { work, chapters } } }));
    } catch {
      // 后端不可用时保持现状（本地模式无发布能力）
    } finally {
      set({ loading: false });
    }
  },

  markPublished: async (novelId, chapters) => {
    const cur = get().byNovel[novelId] ?? { work: null, chapters: [] };
    const known = new Set(cur.chapters.map((c) => c.chapter_id));
    const merged = [...cur.chapters, ...chapters.filter((c) => !known.has(c.chapter_id))];
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: { ...cur, chapters: merged } } }));
    await get().load(novelId);
  },

  markUnpublished: async (novelId, chapterId) => {
    const cur = get().byNovel[novelId];
    if (cur) {
      set((s) => ({
        byNovel: {
          ...s.byNovel,
          [novelId]: { ...cur, chapters: cur.chapters.filter((c) => c.chapter_id !== chapterId) },
        },
      }));
    }
    await get().load(novelId);
  },

  clear: () => set({ byNovel: {} }),
}));

/** 判定某章是否已发布（系统事实）；未加载时返回 false 由调用方兜底 node.status */
export function isChapterPublished(novelId: number | undefined, chapterId: number | undefined | null): boolean {
  if (!novelId || !chapterId) return false;
  const st = usePublishStore.getState().byNovel[novelId];
  return !!st?.chapters.some((c) => c.chapter_id === chapterId);
}
