import { create } from 'zustand';
import type { MediaContent, MediaPlatform, TopicItem } from '@/types/media';
import {
  fetchMediaContents,
  createMediaContent,
  updateMediaContent,
  deleteMediaContent,
  reorderMediaContents,
  fetchTopics,
  saveTopics,
} from '@/services/media-client';

const TOPIC_KEY = 'inkbloom-media-topics';

interface MediaState {
  contents: MediaContent[];
  currentContent: MediaContent | null;
  topics: TopicItem[];
  loading: boolean;

  loadContents: () => Promise<void>;
  createContent: (data: { title: string; platform: MediaPlatform }) => Promise<MediaContent>;
  selectContent: (content: MediaContent) => void;
  saveContent: (id: number, patch: Partial<MediaContent>) => Promise<void>;
  removeContent: (id: number) => Promise<void>;
  reorderContents: (orderedIds: number[]) => Promise<void>;

  loadTopics: () => Promise<void>;
  addTopic: (title: string, note?: string) => void;
  setTopicStatus: (id: string, status: TopicItem['status']) => void;
  removeTopic: (id: string) => void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  contents: [],
  currentContent: null,
  topics: [],
  loading: false,

  loadContents: async () => {
    set({ loading: true });
    try {
      const contents = await fetchMediaContents();
      set({ contents });
    } finally {
      set({ loading: false });
    }
  },

  createContent: async (data) => {
    const content = await createMediaContent(data);
    set((s) => ({ contents: [content, ...s.contents], currentContent: content }));
    return content;
  },

  selectContent: (content) => {
    set({ currentContent: content });
  },

  saveContent: async (id, patch) => {
    // 乐观更新
    set((s) => ({
      contents: s.contents.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      currentContent:
        s.currentContent?.id === id ? { ...s.currentContent, ...patch } : s.currentContent,
    }));
    try {
      await updateMediaContent(id, patch);
    } catch (e) {
      console.error('saveContent failed', e);
    }
  },

  removeContent: async (id) => {
    try {
      await deleteMediaContent(id);
    } catch (e) {
      console.error('removeContent failed', e);
    }
    set((s) => ({
      contents: s.contents.filter((c) => c.id !== id),
      currentContent: s.currentContent?.id === id ? null : s.currentContent,
    }));
  },

  reorderContents: async (orderedIds) => {
    // 乐观更新
    set((s) => {
      const byId = new Map(s.contents.map((c) => [c.id, c]));
      const next: MediaContent[] = [];
      orderedIds.forEach((id) => {
        const c = byId.get(id);
        if (c) {
          next.push(c);
          byId.delete(id);
        }
      });
      byId.forEach((c) => next.push(c));
      return { contents: next };
    });
    try {
      await reorderMediaContents(orderedIds);
    } catch (e) {
      console.error('reorderContents failed', e);
    }
  },

  loadTopics: async () => {
    try {
      const topics = await fetchTopics();
      set({ topics });
    } catch {
      try {
        const raw = localStorage.getItem(TOPIC_KEY);
        set({ topics: raw ? JSON.parse(raw) : [] });
      } catch {
        set({ topics: [] });
      }
    }
  },

  addTopic: (title, note = '') => {
    const topic: TopicItem = {
      id: crypto.randomUUID(),
      title,
      note,
      status: 'idea',
      created_at: new Date().toISOString(),
    };
    const topics = [topic, ...get().topics];
    set({ topics });
    saveTopics(topics);
  },

  setTopicStatus: (id, status) => {
    const topics = get().topics.map((t) => (t.id === id ? { ...t, status } : t));
    set({ topics });
    saveTopics(topics);
  },

  removeTopic: (id) => {
    const topics = get().topics.filter((t) => t.id !== id);
    set({ topics });
    saveTopics(topics);
  },
}));
