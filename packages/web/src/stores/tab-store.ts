import { create } from 'zustand';

/** 保存状态（与 editor-store 镜像语义一致） */
export type TabSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * tab 类型：chapter = 章节正文编辑器；panel 类 = 中央标签页内的编辑面板。
 * Home 类（overview 全书首页 / story AI 起稿）同样以可关闭 tab 形式驻留标签栏，
 * 关闭即消失，不再挤压/顶替编辑板。
 */
export type TabKind = 'chapter' | 'outline-node' | 'memory' | 'overview' | 'story';

/** panel 类 tab 的定位信息（按 kind 取用） */
export interface TabMeta {
  /** outline-node：所属幕 id */
  actId?: string;
  /** outline-node：节点 id */
  nodeId?: string;
  /** memory：条目 id；缺省 = 新建 */
  itemId?: string;
  /** memory 新建时的默认分组 */
  newType?: string;
  novelId?: number;
}

/** 编辑板：草稿随 tab 缓存，切换不丢编辑状态（不 persist，草稿体积大） */
export interface EditorTab {
  /** 形如 `chapter-{id}` / `outline-node-{nodeId}` / `memory-{itemId|new-{type}}` */
  key: string;
  kind: TabKind;
  /** chapter 类 tab 的章节 id；panel 类无章节归属 */
  chapterId?: number;
  title: string;
  /** HTML 草稿：单 TipTap 实例换绑的源（chapter 类专用） */
  draft: string;
  wordCount: number;
  isDirty: boolean;
  saveStatus: TabSaveStatus;
  /** 正文加载失败（F2-8）：编辑器内容可能不完整，阻断自动保存直到重载成功 */
  loadError?: boolean;
  /** panel 类 tab 的定位信息 */
  meta?: TabMeta;
}

/** 章节 id → tab key */
export const chapterTabKey = (chapterId: number) => `chapter-${chapterId}`;
/** 全书首页（概览）tab key：每部作品一个 */
export const overviewTabKey = (novelId: number) => `overview-${novelId}`;
/** AI 起稿 Home tab（全局单例） */
export const STORY_TAB_KEY = 'story';

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
  /** 打开 panel 类 tab（大纲节点编辑器 / 记忆条目编辑器）：已存在则激活并同步标题 */
  openPanelTab: (
    key: string,
    title: string,
    kind: Exclude<TabKind, 'chapter'>,
    meta: TabMeta,
  ) => void;
  /** 关闭 tab；调用方负责先 flush 未落盘保存。关闭 active 后自动激活相邻 tab */
  closeTab: (key: string) => void;
  setActive: (key: string) => void;
  /** 局部更新 tab 字段（key 不可变） */
  updateTab: (key: string, patch: Partial<Omit<EditorTab, 'key'>>) => void;
  renameTab: (key: string, title: string) => void;
  /** 清理 chapterId 不在 validIds 内的章节 tab（章节删除/切换作品后）；panel 类不受影响 */
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
      kind: 'chapter',
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

  openPanelTab: (key, title, kind, meta) => {
    const existing = get().tabs.find((t) => t.key === key);
    if (existing) {
      set((s) => ({
        activeKey: key,
        tabs: existing.title === title ? s.tabs : s.tabs.map((t) => (t.key === key ? { ...t, title, meta } : t)),
      }));
      return;
    }
    const tab: EditorTab = {
      key,
      kind,
      title,
      draft: '',
      wordCount: 0,
      isDirty: false,
      saveStatus: 'idle',
      meta,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeKey: key }));
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
      const tabs = s.tabs.filter((t) => t.kind !== 'chapter' || (t.chapterId != null && valid.has(t.chapterId)));
      const activeKey =
        s.activeKey && tabs.some((t) => t.key === s.activeKey) ? s.activeKey : tabs[0]?.key ?? null;
      return { tabs, activeKey };
    });
  },

  reset: () => set({ tabs: [], activeKey: null }),
}));
