import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { toast } from '@/components/common/Toast';
import {
  localNovels,
  createLocalNovel,
  removeLocalNovel,
  localChapters,
  createLocalChapter,
  removeLocalChapter,
  updateLocalChapter,
  reorderLocalChapters,
  getLocalContent,
} from '@/services/local-backend';
import type { Novel, Chapter } from '@/types';
import type { CreateNovelRequest, UpdateNovelRequest, CreateChapterRequest } from '@/types';
import { useTabStore, chapterTabKey, countDraftWords } from './tab-store';
import { useEditorStore } from './editor-store';
import { useOutlineStore, sortChaptersByOutline } from './outline-store';

const DEV_MOCK = import.meta.env.DEV;

interface NovelStore {
  novels: Novel[];
  currentNovel: Novel | null;
  chapters: Chapter[];
  currentChapter: Chapter | null;
  loading: boolean;

  fetchNovels: () => Promise<void>;
  createNovel: (data: CreateNovelRequest) => Promise<Novel>;
  updateNovel: (id: number, data: UpdateNovelRequest) => Promise<void>;
  deleteNovel: (id: number) => Promise<void>;
  selectNovel: (novel: Novel) => Promise<void>;
  /** 清空当前选定作品（新建小说入口进入「需填书名」的全本创作模式时使用） */
  deselectNovel: () => void;
  fetchChapters: (novelId: number) => Promise<void>;
  /** 本地更新章节字数（自动保存成功后替代全量 fetchChapters，F2-7） */
  updateChapterWordCount: (id: number, wordCount: number) => void;
  createChapter: (data: CreateChapterRequest, insertAt?: number) => Promise<Chapter>;
  renameChapter: (id: number, title: string) => Promise<void>;
  reorderChapters: (orderedIds: number[]) => Promise<void>;
  selectChapter: (chapter: Chapter) => Promise<void>;
  deleteChapter: (id: number) => Promise<void>;
}

/** 按 sort_order 升序（回退 created_at）规范化章节序列 */
const sortChapters = (list: Chapter[]): Chapter[] =>
  [...list].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

export const useNovelStore = create<NovelStore>((set, get) => ({
  novels: [],
  currentNovel: null,
  chapters: [],
  currentChapter: null,
  loading: false,

  fetchNovels: async () => {
    set({ loading: true });
    try {
      const data = await apiClient.get('/novels', { params: { page: 1, page_size: 100 } }) as any;
      const novels: Novel[] = data?.novels ?? data?.items ?? [];
      set({ novels });
      // 刷新后自动恢复上次选中的作品（问题3：避免大纲/记忆因 currentNovel 丢失而"消失"）
      const lastId = localStorage.getItem('inkbloom:currentNovelId');
      if (lastId && !get().currentNovel) {
        const nid = Number(lastId);
        const restored = novels.find((n) => n.id === nid);
        if (restored) void get().selectNovel(restored);
        else localStorage.removeItem('inkbloom:currentNovelId');
      }
    } catch (e) {
      console.error('fetchNovels failed', e);
      if (DEV_MOCK) set({ novels: localNovels() });
    } finally {
      set({ loading: false });
    }
  },

  createNovel: async (data) => {
    try {
      const novel = await apiClient.post('/novels', data) as unknown as Novel;
      set((s) => ({ novels: [novel, ...s.novels] }));
      return novel;
    } catch (e) {
      if (!DEV_MOCK) throw e;
      const novel = createLocalNovel(data);
      set((s) => ({ novels: [novel, ...s.novels] }));
      return novel;
    }
  },

  updateNovel: async (id, data) => {
    const updated = await apiClient.put(`/novels/${id}`, data) as any;
    set((s) => ({
      novels: s.novels.map((n) => (n.id === id ? { ...n, ...updated } : n)),
      currentNovel: s.currentNovel?.id === id ? { ...s.currentNovel, ...updated } : s.currentNovel,
    }));
  },

  deleteNovel: async (id) => {
    try {
      await apiClient.delete(`/novels/${id}`);
    } catch (e) {
      if (!DEV_MOCK) throw e;
      removeLocalNovel(id);
    }
    try {
      if (localStorage.getItem('inkbloom:currentNovelId') === String(id)) {
        localStorage.removeItem('inkbloom:currentNovelId');
      }
    } catch {
      // ignore
    }
    set((s) => ({
      novels: s.novels.filter((n) => n.id !== id),
      currentNovel: s.currentNovel?.id === id ? null : s.currentNovel,
      chapters: s.currentNovel?.id === id ? [] : s.chapters,
      currentChapter: s.currentNovel?.id === id ? null : s.currentChapter,
    }));
  },

  selectNovel: async (novel) => {
    // 切换作品前先把脏草稿尽力落盘，随后 fetchChapters 按新章节 id 清理失效 tab
    useEditorStore.getState().flushDirtyTabs();
    set({ currentNovel: novel, currentChapter: null });
    try {
      localStorage.setItem('inkbloom:currentNovelId', String(novel.id));
    } catch {
      // localStorage 不可用（隐私模式等）时静默忽略
    }
    await get().fetchChapters(novel.id);
  },

  deselectNovel: () => {
    set({ currentNovel: null, currentChapter: null });
    try {
      localStorage.removeItem('inkbloom:currentNovelId');
    } catch {
      // localStorage 不可用（隐私模式等）时静默忽略
    }
  },

  fetchChapters: async (novelId) => {
    try {
      const data = await apiClient.get(`/novels/${novelId}/chapters`) as any;
      const chapters: Chapter[] = Array.isArray(data) ? data : data?.chapters ?? data?.items ?? [];
      const sorted = sortChapters(chapters);
      set({ chapters: sorted });
      useTabStore.getState().prune(sorted.map((c) => c.id));
    } catch (e) {
      console.error('fetchChapters failed', e);
      const chapters = DEV_MOCK ? sortChapters(localChapters(novelId)) : [];
      set({ chapters });
      useTabStore.getState().prune(chapters.map((c) => c.id));
    }
    // 备忘录 L57：章节顺序严格按大纲排列顺序。大纲已加载则立即重排；
    // 未加载则先拉大纲（幂等）再重排。
    const ost = useOutlineStore.getState();
    if (ost.byNovel[novelId]) {
      resortChaptersByOutline(novelId);
    } else {
      void useOutlineStore.getState().loadOutline(novelId).then(() => resortChaptersByOutline(novelId));
    }
  },

  updateChapterWordCount: (id, wordCount) => {
    set((s) => ({
      chapters: s.chapters.map((c) => (c.id === id ? { ...c, word_count: wordCount } : c)),
      currentChapter: s.currentChapter?.id === id ? { ...s.currentChapter, word_count: wordCount } : s.currentChapter,
    }));
  },

  createChapter: async (data, insertAt) => {
    try {
      // 后端预留：position 字段待 server 实现，当前忽略后由前端排序兼容
      const chapter = await apiClient.post('/chapters', { ...data, position: insertAt }) as unknown as Chapter;
      set((s) => {
        const next = [...s.chapters];
        const at = insertAt == null || insertAt >= next.length ? next.length : Math.max(0, insertAt);
        next.splice(at, 0, chapter);
        return { chapters: next.map((c, i) => ({ ...c, sort_order: i + 1 })) };
      });
      return chapter;
    } catch (e) {
      if (!DEV_MOCK) throw e;
      const chapter = createLocalChapter({
        novel_id: data.novel_id,
        title: data.title,
        content: data.content,
        position: insertAt,
      });
      set((s) => {
        const next = [...s.chapters];
        const at = insertAt == null || insertAt >= next.length ? next.length : Math.max(0, insertAt);
        next.splice(at, 0, chapter);
        return { chapters: next.map((c, i) => ({ ...c, sort_order: i + 1 })) };
      });
      return chapter;
    }
  },

  renameChapter: async (id, title) => {
    try {
      await apiClient.put(`/chapters/${id}`, { title });
    } catch (e) {
      if (!DEV_MOCK) throw e;
      updateLocalChapter(id, { title });
    }
    set((s) => ({
      chapters: s.chapters.map((c) => (c.id === id ? { ...c, title } : c)),
      currentChapter: s.currentChapter?.id === id ? { ...s.currentChapter, title } : s.currentChapter,
    }));
  },

  reorderChapters: async (orderedIds) => {
    const novelId = get().currentNovel?.id;
    if (!novelId) return;
    // 乐观更新：按传入顺序重排并规范化 sort_order
    set((s) => {
      const byId = new Map(s.chapters.map((c) => [c.id, c]));
      const next: Chapter[] = [];
      orderedIds.forEach((id) => {
        const c = byId.get(id);
        if (c) {
          next.push(c);
          byId.delete(id);
        }
      });
      byId.forEach((c) => next.push(c));
      return { chapters: next.map((c, i) => ({ ...c, sort_order: i + 1 })) };
    });
    reorderLocalChapters(novelId, orderedIds);
    try {
      // 后端预留：批量排序端点待 server 实现
      await apiClient.put(`/novels/${novelId}/chapters/order`, { ordered_ids: orderedIds });
    } catch {
      /* DEV 降级已本地持久化 */
    }
  },

  selectChapter: async (chapter) => {
    const key = chapterTabKey(chapter.id);
    // 已打开的 tab 直接切换：草稿以 tab-store 为准，不重拉内容，编辑状态不丢
    const created = useTabStore.getState().openTab(chapter.id, chapter.title, chapter.content || '');
    if (!created) {
      const draft = useTabStore.getState().tabs.find((t) => t.key === key)?.draft ?? '';
      set({ currentChapter: { ...chapter, content: draft } });
      return;
    }
    set({ currentChapter: chapter });
    try {
      const data = await apiClient.get(`/chapters/${chapter.id}/content`) as any;
      const content = data?.content ?? data?.content_json ?? '';
      set({ currentChapter: { ...chapter, content, content_json: data?.content_json } });
      useTabStore.getState().updateTab(key, {
        draft: content,
        wordCount: countDraftWords(content),
        loadError: false,
      });
    } catch (e) {
      console.error('selectChapter load content failed', e);
      if (DEV_MOCK) {
        // 已有内容（如刚写入的初稿）优先，其次本地缓存
        const content = chapter.content || getLocalContent(chapter.id) || '';
        set({ currentChapter: { ...chapter, content } });
        useTabStore.getState().updateTab(key, { draft: content, wordCount: countDraftWords(content) });
      } else {
        // F2-8：静默失败会让用户对着可能不完整的编辑器动笔，一动笔就
        // 以空/截断内容覆盖正文。显式标记 loadError 并提示。
        toast.show('章节内容加载失败，请点击重试后再编辑，避免覆盖正文', 'error');
        useTabStore.getState().updateTab(key, { loadError: true });
      }
    }
  },

  deleteChapter: async (id) => {
    try {
      await apiClient.delete(`/chapters/${id}`);
    } catch (e) {
      if (!DEV_MOCK) throw e;
      removeLocalChapter(id);
    }
    // 同步关闭对应 tab（草稿随章节作废，不再落盘）
    useTabStore.getState().closeTab(chapterTabKey(id));
    set((s) => {
      const chapters = s.chapters.filter((c) => c.id !== id);
      let currentChapter = s.currentChapter;
      if (s.currentChapter?.id === id) {
        // 被删章节正在编辑：currentChapter 跟随 tab 激活项回退（保持编辑器/面板一致）
        const { tabs, activeKey } = useTabStore.getState();
        const next = tabs.find((t) => t.key === activeKey);
        const ch = next ? chapters.find((c) => c.id === next.chapterId) : undefined;
        currentChapter = ch && next ? { ...ch, content: next.draft } : null;
      }
      return { chapters, currentChapter };
    });
  },
}));

/** 按大纲顺序重排当前作品的 chapters（备忘录 L57）。大纲未加载时跳过。 */
function resortChaptersByOutline(novelId: number) {
  const acts = useOutlineStore.getState().byNovel[novelId];
  if (!acts || acts.length === 0) return;
  useNovelStore.setState((s) =>
    s.currentNovel?.id === novelId ? { chapters: sortChaptersByOutline(s.chapters, acts) } : {},
  );
}

// 大纲变化（移动节点/绑定成稿/增删）后即时重排章节，保证章节序列始终严格跟随大纲
useOutlineStore.subscribe((s, prev) => {
  const nid = useNovelStore.getState().currentNovel?.id;
  if (!nid) return;
  if (s.byNovel[nid] !== prev.byNovel[nid]) resortChaptersByOutline(nid);
});
