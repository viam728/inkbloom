import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { setLocalContent } from '@/services/local-backend';
import { useNovelStore } from './novel-store';

const DEV_MOCK = import.meta.env.DEV;

interface EditorStore {
  content: string;
  wordCount: number;
  isDirty: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';

  setContent: (content: string) => void;
  setWordCount: (count: number) => void;
  saveChapter: (chapterId: number) => Promise<void>;
  resetDirty: () => void;
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

  saveChapter: async (chapterId) => {
    const { content, saveStatus } = get();
    if (saveStatus === 'saving') return;
    set({ saveStatus: 'saving' });
    try {
      await apiClient.put(`/chapters/${chapterId}`, { content }) as any;
      set({ saveStatus: 'saved', isDirty: false });
      // 刷新章节列表以更新字数等
      const currentNovel = useNovelStore.getState().currentNovel;
      if (currentNovel) {
        await useNovelStore.getState().fetchChapters(currentNovel.id);
      }
    } catch (e) {
      console.error('saveChapter failed', e);
      if (DEV_MOCK) {
        // 后端不可用：降级本地保存，保持无感
        setLocalContent(chapterId, content);
        set({ saveStatus: 'saved', isDirty: false });
      } else {
        set({ saveStatus: 'error' });
      }
    }
  },

  resetDirty: () => {
    set({ isDirty: false, saveStatus: 'idle', content: '', wordCount: 0 });
  },
}));
