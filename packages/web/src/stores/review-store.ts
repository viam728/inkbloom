import { create } from 'zustand';
import { requestReview } from '@/services/ai-actions-client';

export type ReviewSeverity = 'praise' | 'suggestion' | 'issue';

export interface ReviewAnnotation {
  id: string;
  /** 原文引用，用于定位跳转 */
  quote: string;
  comment: string;
  suggestion?: string;
  severity: ReviewSeverity;
  resolved: boolean;
}

/** AI 批注评审模式：像编辑一样在文中留下批注，逐条处理 */
interface ReviewState {
  annotations: ReviewAnnotation[];
  reviewing: boolean;
  /** 当前已审阅的章节 id */
  reviewedChapterId: number | null;

  runReview: (chapterId: number, text: string) => Promise<void>;
  resolve: (id: string) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useReviewStore = create<ReviewState>((set) => ({
  annotations: [],
  reviewing: false,
  reviewedChapterId: null,

  runReview: async (chapterId, text) => {
    set({ reviewing: true });
    try {
      const annotations = await requestReview(chapterId, text);
      set({
        annotations: annotations.map((a) => ({ ...a, resolved: false })),
        reviewedChapterId: chapterId,
      });
    } finally {
      set({ reviewing: false });
    }
  },

  resolve: (id) =>
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? { ...a, resolved: true } : a)),
    })),

  dismiss: (id) =>
    set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) })),

  clear: () => set({ annotations: [], reviewedChapterId: null }),
}));

/** 定位跳转：通知编辑器选中指定文本 */
export const locateTextInEditor = (text: string) => {
  window.dispatchEvent(new CustomEvent('inkbloom:locate-text', { detail: { text } }));
};
