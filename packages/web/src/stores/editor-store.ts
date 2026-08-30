import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { setLocalContent } from '@/services/local-backend';
import { useNovelStore } from './novel-store';
import { useTabStore, chapterTabKey, type EditorTab } from './tab-store';

const DEV_MOCK = import.meta.env.DEV;

interface EditorStore {
  /** 以下四项为当前 active tab 的镜像，由 EditorArea 经 mirrorTab 灌入（供 ReviewPanel 等既有消费者读取） */
  content: string;
  wordCount: number;
  isDirty: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';

  setContent: (content: string) => void;
  setWordCount: (count: number) => void;
  /** 保存章节：content 缺省时回退对应 tab 草稿（再回退镜像值），保存结果回写 tab-store */
  saveChapter: (chapterId: number, content?: string) => Promise<void>;
  /** 以 active tab 同步镜像（tab 为 null 时清空镜像） */
  mirrorTab: (tab: EditorTab | null) => void;
  /** 立即保存所有脏 tab（切换作品等清理场景前置 flush，保存为异步尽力而为） */
  flushDirtyTabs: () => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  content: '',
  wordCount: 0,
  isDirty: false,
  saveStatus: 'idle',

  setContent: (content) => {
    set({ content, isDirty: true });
  },

  setWordCount: (count) => {
    set({ wordCount: count });
  },

  saveChapter: async (chapterId, content) => {
    const tabKey = chapterTabKey(chapterId);
    const tabStore = useTabStore.getState();
    const tab = tabStore.tabs.find((t) => t.key === tabKey);
    if (tab?.saveStatus === 'saving') return;
    // 正文取参顺序：显式入参（调用方 flush 的草稿快照）→ tab 草稿 → 镜像值
    const body = content ?? tab?.draft ?? get().content;
    const isActive = tabStore.activeKey === tabKey;
    tabStore.updateTab(tabKey, { saveStatus: 'saving' });
    if (isActive) set({ saveStatus: 'saving' });
    try {
      await apiClient.put(`/chapters/${chapterId}`, { content: body }) as any;
      useTabStore.getState().updateTab(tabKey, { isDirty: false, saveStatus: 'saved' });
      if (useTabStore.getState().activeKey === tabKey) set({ saveStatus: 'saved', isDirty: false });
      // 刷新章节列表以更新字数等
      const currentNovel = useNovelStore.getState().currentNovel;
      if (currentNovel) {
        await useNovelStore.getState().fetchChapters(currentNovel.id);
      }
      // 通知主动提示条刷新：刚写完，伏笔的超期状态可能刚变化（业务方案 v3 A15）
      window.dispatchEvent(
        new CustomEvent('inkbloom:chapter-saved', { detail: { chapterId } }),
      );
    } catch (e) {
      console.error('saveChapter failed', e);
      if (DEV_MOCK) {
        // 后端不可用：降级本地保存，保持无感
        setLocalContent(chapterId, body);
        useTabStore.getState().updateTab(tabKey, { isDirty: false, saveStatus: 'saved' });
        if (useTabStore.getState().activeKey === tabKey) set({ saveStatus: 'saved', isDirty: false });
      } else {
        useTabStore.getState().updateTab(tabKey, { saveStatus: 'error' });
        if (useTabStore.getState().activeKey === tabKey) set({ saveStatus: 'error' });
      }
    }
  },

  mirrorTab: (tab) => {
    if (!tab) {
      set({ content: '', wordCount: 0, isDirty: false, saveStatus: 'idle' });
      return;
    }
    set({
      content: tab.draft,
      wordCount: tab.wordCount,
      isDirty: tab.isDirty,
      saveStatus: tab.saveStatus,
    });
  },

  flushDirtyTabs: () => {
    const { saveChapter } = get();
    for (const t of useTabStore.getState().tabs) {
      if (t.isDirty && t.saveStatus !== 'saving') {
        void saveChapter(t.chapterId, t.draft);
      }
    }
  },
}));
