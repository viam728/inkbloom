import { create } from 'zustand';
import { generateCandidates, type AIAction } from '@/services/ai-actions-client';
import { useAIStore } from './ai-store';

interface CandidatePos {
  left: number;
  top: number;
}

/** 多候选生成（N 选 1）状态 */
interface CandidatesState {
  visible: boolean;
  loading: boolean;
  action: AIAction | null;
  items: string[];
  /** 浮层定位（编辑器坐标系，fixed 定位） */
  pos: CandidatePos | null;
  error: string | null;

  request: (action: AIAction, context: string, pos: CandidatePos) => Promise<void>;
  dismiss: () => void;
}

export const useCandidatesStore = create<CandidatesState>((set, get) => ({
  visible: false,
  loading: false,
  action: null,
  items: [],
  pos: null,
  error: null,

  request: async (action, context, pos) => {
    set({ visible: true, loading: true, action, items: [], pos, error: null });
    try {
      const model = useAIStore.getState().currentModel;
      const items = await generateCandidates(action, context, model);
      // 防止请求期间被关闭
      if (!get().visible) return;
      set({ items, loading: false });
    } catch {
      if (!get().visible) return;
      set({ loading: false, error: '生成失败，请检查 AI 服务连接' });
    }
  },

  dismiss: () => set({ visible: false, items: [], loading: false, action: null, error: null }),
}));
