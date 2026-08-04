import { create } from 'zustand';
import apiClient from '@/services/api-client';
import type { GraphData, ConsistencyIssue } from '@/types/knowledge';

interface KnowledgeStore {
  graph: GraphData | null;
  loading: boolean;
  extracting: boolean;
  checking: boolean;

  fetchGraph: (novelId: number) => Promise<void>;
  extractEntities: (novelId: number, chapterId: number, text: string) => Promise<void>;
  checkConsistency: (novelId: number, chapterId: number, text: string) => Promise<ConsistencyIssue[]>;
}

export const useKnowledgeStore = create<KnowledgeStore>((set, get) => ({
  graph: null,
  loading: false,
  extracting: false,
  checking: false,

  fetchGraph: async (novelId: number) => {
    set({ loading: true });
    try {
      const data = await apiClient.get(`/knowledge/graph/${novelId}`) as unknown as GraphData;
      set({ graph: data });
    } catch (e) {
      console.error('fetchGraph failed', e);
      set({ graph: null });
    } finally {
      set({ loading: false });
    }
  },

  extractEntities: async (novelId: number, chapterId: number, text: string) => {
    set({ extracting: true });
    try {
      await apiClient.post('/knowledge/extract', {
        novel_id: novelId,
        chapter_id: chapterId,
        text,
      });
      // Refresh graph after extraction
      await get().fetchGraph(novelId);
    } catch (e) {
      console.error('extractEntities failed', e);
      throw e;
    } finally {
      set({ extracting: false });
    }
  },

  checkConsistency: async (novelId: number, chapterId: number, text: string) => {
    set({ checking: true });
    try {
      const data = await apiClient.post('/knowledge/check', {
        novel_id: novelId,
        chapter_id: chapterId,
        text,
      }) as unknown as ConsistencyIssue[];
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('checkConsistency failed', e);
      return [];
    } finally {
      set({ checking: false });
    }
  },
}));
