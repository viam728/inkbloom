import { create } from 'zustand';
import { fetchMemory, saveMemory } from '@/services/memory-client';

export type MemoryType = 'character' | 'setting' | 'summary';

export interface MemoryItem {
  id: string;
  type: MemoryType;
  name: string;
  content: string;
  tags: string[];
  /** 置顶条目始终排在最前，AI 上下文注入时优先携带 */
  pinned?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** 作品记忆面板：人物卡 / 设定集 / 前情摘要，为 AI 提供长期上下文 */
interface MemoryState {
  /** 按 novel_id 缓存 */
  byNovel: Record<number, MemoryItem[]>;
  loading: boolean;
  saving: boolean;

  loadMemory: (novelId: number) => Promise<void>;
  addItem: (novelId: number, item: Omit<MemoryItem, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  updateItem: (novelId: number, itemId: string, patch: Partial<Omit<MemoryItem, 'id'>>) => Promise<void>;
  togglePin: (novelId: number, itemId: string) => Promise<void>;
  removeItem: (novelId: number, itemId: string) => Promise<void>;
}

const persistLocal = (novelId: number, items: MemoryItem[]) => {
  try {
    localStorage.setItem(`inkbloom-memory-${novelId}`, JSON.stringify(items));
  } catch {
    /* ignore */
  }
};

const now = () => new Date().toISOString();

export const useMemoryStore = create<MemoryState>((set, get) => ({
  byNovel: {},
  loading: false,
  saving: false,

  loadMemory: async (novelId) => {
    set({ loading: true });
    try {
      const items = await fetchMemory(novelId);
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: items } }));
    } catch {
      // 后端不可用时回退本地缓存
      try {
        const raw = localStorage.getItem(`inkbloom-memory-${novelId}`);
        const items: MemoryItem[] = raw ? JSON.parse(raw) : [];
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: items } }));
      } catch {
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: [] } }));
      }
    } finally {
      set({ loading: false });
    }
  },

  addItem: async (novelId, item) => {
    const full: MemoryItem = { ...item, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
    await commit(set, get, novelId, (items) => [full, ...items]);
  },

  updateItem: async (novelId, itemId, patch) => {
    await commit(set, get, novelId, (items) =>
      items.map((i) => (i.id === itemId ? { ...i, ...patch, updated_at: now() } : i)),
    );
  },

  togglePin: async (novelId, itemId) => {
    await commit(set, get, novelId, (items) =>
      items.map((i) => (i.id === itemId ? { ...i, pinned: !i.pinned, updated_at: now() } : i)),
    );
  },

  removeItem: async (novelId, itemId) => {
    await commit(set, get, novelId, (items) => items.filter((i) => i.id !== itemId));
  },
}));

/** 统一提交：乐观更新 → 本地持久化 → 尽力同步后端 */
async function commit(
  set: (fn: (s: MemoryState) => Partial<MemoryState>) => void,
  get: () => MemoryState,
  novelId: number,
  transform: (items: MemoryItem[]) => MemoryItem[],
) {
  const items = transform(get().byNovel[novelId] ?? []);
  set((s) => ({ byNovel: { ...s.byNovel, [novelId]: items }, saving: true }));
  persistLocal(novelId, items);
  try {
    await saveMemory(novelId, items);
  } catch {
    /* 后端不可用，仅本地保存 */
  } finally {
    set(() => ({ saving: false }));
  }
}

/** 置顶优先、其次按更新时间倒序（兼容无时间戳的旧数据） */
export function sortMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
  });
}
