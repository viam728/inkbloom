import { create } from 'zustand';
import { fetchOutline, saveOutline, normalizeOutlineActs } from '@/services/outline-client';

/** 写作状态两态：写作中 → 已完成（用户可切换）；已发布由发布系统写入 */
export type OutlineStatus = 'drafting' | 'done' | 'published';

export const OUTLINE_STATUS_LABELS: Record<OutlineStatus, string> = {
  drafting: '写作中',
  done: '已完成',
  published: '已发布',
};

/** 用户可手动切换的写作状态闭集；published 由发布系统写入，UI 不可手改 */
export const WRITABLE_OUTLINE_STATUSES: OutlineStatus[] = ['drafting', 'done'];

/** 两态互切：写作中 ↔ 已完成 */
export const toggleWritingStatus = (s: OutlineStatus): OutlineStatus =>
  s === 'done' ? 'drafting' : 'done';

/**
 * 大纲顺序的成稿章节 id 序列（备忘录 L57：章节顺序严格按大纲排列顺序）。
 * acts → nodes 的数组序即大纲序；未绑定 chapter_id 的节点（尚未成稿）跳过。
 */
export function outlineChapterOrder(acts: OutlineAct[] | undefined): number[] {
  const ids: number[] = [];
  for (const act of acts ?? []) {
    for (const node of act.nodes) {
      if (node.chapter_id != null) ids.push(node.chapter_id);
    }
  }
  return ids;
}

/**
 * 按大纲顺序排序章节：绑定大纲的章节按大纲序排在前，未绑定的按原顺序垫后。
 * 大纲未加载/为空时原样返回。
 */
export function sortChaptersByOutline<T extends { id: number }>(
  chapters: T[],
  acts: OutlineAct[] | undefined,
): T[] {
  const order = outlineChapterOrder(acts);
  if (order.length === 0 || chapters.length <= 1) return chapters;
  const rank = new Map(order.map((id, i) => [id, i]));
  const bound = chapters.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = chapters.filter((c) => !rank.has(c.id));
  return [...bound, ...rest];
}

/** 章节大纲节点 */
export interface OutlineNode {
  id: string;
  /** 章节标题（成稿章节将以此命名） */
  title: string;
  /** 剧情要点（支持多行） */
  summary: string;
  status: OutlineStatus;
  /** 已关联的成稿章节 id */
  chapter_id?: number;
  /** 扩写时引用的作品记忆条目名 */
  memory_refs?: string[];
}

/** 幕 / 卷：大纲分组 */
export interface OutlineAct {
  id: string;
  title: string;
  nodes: OutlineNode[];
}

interface OutlineState {
  /** 按 novel_id 缓存 */
  byNovel: Record<number, OutlineAct[]>;
  loading: boolean;
  saving: boolean;

  loadOutline: (novelId: number) => Promise<void>;
  addAct: (novelId: number, title: string) => OutlineAct;
  updateAct: (novelId: number, actId: string, title: string) => void;
  removeAct: (novelId: number, actId: string) => void;
  moveAct: (novelId: number, actId: string, dir: -1 | 1) => void;
  addNode: (novelId: number, actId: string) => OutlineNode;
  /** 幕内按位置插入新要点（index 越界自动收敛到首/尾）；省略号菜单「上/下方添加」用 */
  addNodeAt: (novelId: number, actId: string, index: number) => OutlineNode;
  updateNode: (novelId: number, actId: string, nodeId: string, patch: Partial<OutlineNode>) => void;
  removeNode: (novelId: number, actId: string, nodeId: string) => void;
  moveNode: (novelId: number, actId: string, nodeId: string, dir: -1 | 1) => void;
}

const persistLocal = (novelId: number, acts: OutlineAct[]) => {
  try {
    localStorage.setItem(`inkbloom-outline-${novelId}`, JSON.stringify(acts));
  } catch {
    /* ignore */
  }
};

/** 本地保存并尽力同步后端 */
const commit = (
  set: (fn: (s: OutlineState) => Partial<OutlineState>) => void,
  get: () => OutlineState,
  novelId: number,
  mutate: (acts: OutlineAct[]) => OutlineAct[],
) => {
  const prev = get().byNovel[novelId] ?? [];
  const next = mutate(prev);
  set((s) => ({ byNovel: { ...s.byNovel, [novelId]: next }, saving: true }));
  persistLocal(novelId, next);
  saveOutline(novelId, next)
    .catch(() => {
      /* 后端不可用，仅本地保存 */
    })
    .finally(() => set(() => ({ saving: false })));
  return next;
};

export const useOutlineStore = create<OutlineState>((set, get) => ({
  byNovel: {},
  loading: false,
  saving: false,

  loadOutline: async (novelId) => {
    set({ loading: true });
    try {
      const acts = await fetchOutline(novelId);
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: acts } }));
    } catch {
      // 后端不可用时回退本地缓存；localStorage 里的旧数据同样要规范化
      try {
        const raw = localStorage.getItem(`inkbloom-outline-${novelId}`);
        const acts = normalizeOutlineActs(raw ? JSON.parse(raw) : []);
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: acts } }));
      } catch {
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: [] } }));
      }
    } finally {
      set({ loading: false });
    }
  },

  addAct: (novelId, title) => {
    const act: OutlineAct = {
      id: crypto.randomUUID(),
      title: title || `第 ${(get().byNovel[novelId] ?? []).length + 1} 幕`,
      nodes: [],
    };
    commit(set, get, novelId, (acts) => [...acts, act]);
    return act;
  },

  updateAct: (novelId, actId, title) => {
    commit(set, get, novelId, (acts) =>
      acts.map((a) => (a.id === actId ? { ...a, title } : a)),
    );
  },

  removeAct: (novelId, actId) => {
    commit(set, get, novelId, (acts) => acts.filter((a) => a.id !== actId));
  },

  moveAct: (novelId, actId, dir) => {
    commit(set, get, novelId, (acts) => {
      const idx = acts.findIndex((a) => a.id === actId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= acts.length) return acts;
      const next = [...acts];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  },

  addNode: (novelId, actId) => {
    const node: OutlineNode = {
      id: crypto.randomUUID(),
      title: '',
      summary: '',
      status: 'drafting',
    };
    commit(set, get, novelId, (acts) =>
      acts.map((a) => (a.id === actId ? { ...a, nodes: [...a.nodes, node] } : a)),
    );
    return node;
  },

  addNodeAt: (novelId, actId, index) => {
    const node: OutlineNode = {
      id: crypto.randomUUID(),
      title: '',
      summary: '',
      status: 'drafting',
    };
    commit(set, get, novelId, (acts) =>
      acts.map((a) => {
        if (a.id !== actId) return a;
        const nodes = [...a.nodes];
        const at = Math.max(0, Math.min(index, nodes.length));
        nodes.splice(at, 0, node);
        return { ...a, nodes };
      }),
    );
    return node;
  },

  updateNode: (novelId, actId, nodeId, patch) => {
    commit(set, get, novelId, (acts) =>
      acts.map((a) =>
        a.id === actId
          ? { ...a, nodes: a.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }
          : a,
      ),
    );
  },

  removeNode: (novelId, actId, nodeId) => {
    commit(set, get, novelId, (acts) =>
      acts.map((a) =>
        a.id === actId ? { ...a, nodes: a.nodes.filter((n) => n.id !== nodeId) } : a,
      ),
    );
  },

  moveNode: (novelId, actId, nodeId, dir) => {
    commit(set, get, novelId, (acts) =>
      acts.map((a) => {
        if (a.id !== actId) return a;
        const idx = a.nodes.findIndex((n) => n.id === nodeId);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= a.nodes.length) return a;
        const nodes = [...a.nodes];
        [nodes[idx], nodes[target]] = [nodes[target], nodes[idx]];
        return { ...a, nodes };
      }),
    );
  },
}));
