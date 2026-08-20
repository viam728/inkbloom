import { create } from 'zustand';
import { fetchMediaMemory, saveMediaMemory, isConflictError } from '@/services/memory-client';
import { toast } from '@/components/common/Toast';
import type { MemoryItem } from './memory-store';
import { normalizeMemoryItems } from './memory-store';

/**
 * 自媒体全局记忆：区别于小说的按作品隔离，自媒体模式仅一份全局数据，
 * 所有自媒体内容共享（人设、账号风格、常用素材等长期上下文）。
 * 结构与 memory-store 镜像：乐观更新 → localStorage → 尽力同步后端。
 */
interface MediaMemoryState {
  items: MemoryItem[];
  loading: boolean;
  saving: boolean;

  loadMemory: () => Promise<void>;
  addItem: (item: Omit<MemoryItem, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  updateItem: (itemId: string, patch: Partial<Omit<MemoryItem, 'id'>>) => Promise<void>;
  togglePin: (itemId: string) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  /** 按给定 id 顺序写 order=index，走统一 commit */
  reorderItems: (orderedIds: string[]) => Promise<void>;
}

const LOCAL_KEY = 'inkbloom-media-memory';

const persistLocal = (items: MemoryItem[]) => {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
};

const now = () => new Date().toISOString();

/** 服务端版本号（模块级保存，PUT 时携带） */
let version = 0;

/** 后端同步失败提示节流：短时间内不重复弹 toast */
let lastFailToast = 0;

const toastBackendFail = () => {
  const t = Date.now();
  if (t - lastFailToast < 10_000) return;
  lastFailToast = t;
  toast.show('已保存到本地，稍后将同步', 'info');
};

export const useMediaMemoryStore = create<MediaMemoryState>((set, get) => ({
  items: [],
  loading: false,
  saving: false,

  loadMemory: async () => {
    set({ loading: true });
    try {
      const result = await fetchMediaMemory();
      version = result.version;
      set({ items: normalizeMemoryItems(result.items) });
    } catch {
      // 后端不可用（含端点未就绪）时回退本地缓存
      try {
        const raw = localStorage.getItem(LOCAL_KEY);
        const items: MemoryItem[] = raw ? JSON.parse(raw) : [];
        set({ items: normalizeMemoryItems(items) });
      } catch {
        set({ items: [] });
      }
    } finally {
      set({ loading: false });
    }
  },

  addItem: async (item) => {
    const full: MemoryItem = { ...item, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
    await commit(set, get, (items) => [full, ...items]);
  },

  updateItem: async (itemId, patch) => {
    await commit(set, get, (items) =>
      items.map((i) => (i.id === itemId ? { ...i, ...patch, updated_at: now() } : i)),
    );
  },

  togglePin: async (itemId) => {
    await commit(set, get, (items) =>
      items.map((i) => (i.id === itemId ? { ...i, pinned: !i.pinned, updated_at: now() } : i)),
    );
  },

  removeItem: async (itemId) => {
    await commit(set, get, (items) => items.filter((i) => i.id !== itemId));
  },

  reorderItems: async (orderedIds) => {
    const indexOf = new Map(orderedIds.map((id, idx) => [id, idx]));
    await commit(set, get, (items) =>
      items.map((i) => {
        const idx = indexOf.get(i.id);
        return idx === undefined ? i : { ...i, order: idx };
      }),
    );
  },
}));

/** 统一提交：乐观更新 → 本地持久化 → 尽力同步后端 */
async function commit(
  set: (fn: (s: MediaMemoryState) => Partial<MediaMemoryState>) => void,
  get: () => MediaMemoryState,
  transform: (items: MemoryItem[]) => MemoryItem[],
) {
  const items = transform(get().items);
  set(() => ({ items, saving: true }));
  persistLocal(items);
  try {
    const result = await saveMediaMemory(items, version);
    version = result.version;
  } catch (e) {
    if (isConflictError(e)) {
      // 版本冲突：其他端已更新，重新拉取并提示
      toast.show('记忆已被其他端更新，已刷新', 'info');
      void get().loadMemory();
    } else {
      /* 后端不可用，仅本地保存并提示一次 */
      toastBackendFail();
    }
  } finally {
    set(() => ({ saving: false }));
  }
}
