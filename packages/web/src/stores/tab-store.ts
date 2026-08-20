import { create } from 'zustand';

/** 保存状态（与 editor-store 镜像语义一致） */
export type TabSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** 章节编辑板：草稿随 tab 缓存，切换不丢编辑状态（不 persist，草稿体积大） */
export interface EditorTab {
  /** 形如 `chapter-{id}` */
  key: string;
  chapterId: number;
  title: string;
  /** HTML 草稿：单 TipTap 实例换绑的源 */
  draft: string;
  wordCount: number;
  isDirty: boolean;
  saveStatus: TabSaveStatus;
}

/** 章节 id → tab key */
export const chapterTabKey = (chapterId: number) => `chapter-${chapterId}`;

/** 从 HTML 草稿估算字数（中文按字、英文按词，与编辑器统计口径一致） */
export const countDraftWords = (html: string): number => {
  const plain = (html || '').replace(/<[^>]+>/g, '');
  const cn = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (plain.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
};

interface TabStore {
  tabs: EditorTab[];
  activeKey: string | null;

  /** 打开章节 tab：已存在则置为 active（不覆盖草稿），返回是否新建 */
  openTab: (chapterId: number, title: string, draft?: string) => boolean;
  /** 关闭 tab；调用方负责先 flush 未落盘保存。关闭 active 后自动激活相邻 tab */
  closeTab: (key: string) => void;
  setActive: (key: string) => void;
  /** 局部更新 tab 字段（key/chapterId 不可变） */
  updateTab: (key: string, patch: Partial<Omit<EditorTab, 'key' | 'chapterId'>>) => void;
  renameTab: (key: string, title: string) => void;
  /** 清理 chapterId 不在 validIds 内的 tab（章节删除/切换作品后），active 失效时回退首个 tab */
  prune: (validIds: number[]) => void;
  reset: () => void;
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeKey: null,

  openTab: (chapterId, title, draft = '') => {
    const key = chapterTabKey(chapterId);
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      // 已存在：仅激活并同步标题（列表侧可能已重命名），绝不覆盖在编草稿
      set((s) => ({
        activeKey: key,
        tabs: existing.title === title ? s.tabs : s.tabs.map((t) => (t.key === key ? { ...t, title } : t)),
      }));
      return false;
    }
    const tab: EditorTab = {
      key,
      chapterId,
      title,
      draft,
      wordCount: countDraftWords(draft),
      isDirty: false,
      saveStatus: 'idle',
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
    return true;
  },

  closeTab: (key) => {
    const { tabs, activeKey } = get();
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.key !== key);
    let nextActive = activeKey;
    if (activeKey === key) {
      // 优先激活原位置的后邻，其次前邻
      nextActive = next[idx]?.key ?? next[idx - 1]?.key ?? null;
    }
    set({ tabs: next, activeKey: nextActive });
  },

  setActive: (key) => {
    if (get().tabs.some((t) => t.key === key)) set({ activeKey: key });
  },

  updateTab: (key, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    })),

  renameTab: (key, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, title } : t)),
    })),

  prune: (validIds) => {
    const valid = new Set(validIds);
    set((s) => {
      const tabs = s.tabs.filter((t) => valid.has(t.chapterId));
      const activeKey =
        s.activeKey && tabs.some((t) => t.key === s.activeKey) ? s.activeKey : tabs[0]?.key ?? null;
      return { tabs, activeKey };
    });
  },

  reset: () => set({ tabs: [], activeKey: null }),
}));
