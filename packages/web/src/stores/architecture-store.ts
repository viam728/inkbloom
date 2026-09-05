import { create } from 'zustand';

/**
 * 小说架构（备忘录 L61 预制）：参考记忆库的结构预制的成熟架构组类。
 * UI 双入口：左侧板「架构」导航器（ArchitecturePanel，摘要+跳转）+
 * 中央标签页「小说架构」编辑器（ArchitectureEditor，Home tab，编辑主战场），
 * 共享本 store；同时作为 AIGC 卡「架构」上下文线索源。
 *
 * 预制阶段持久化在浏览器 localStorage（key: inkbloom-architecture-<novelId>），
 * 服务端表结构与迁移后续再接（备忘录：先预制组类，再考虑具体页面复用或实现）。
 */

/** 架构条目（轻量版记忆条目：标题 + 内容） */
export interface ArchEntry {
  id: string;
  title: string;
  content: string;
}

/** 基本信息：流派 / 主题 / 标签 / 规划章节数 / 规划每章字数 / 发布渠道 */
export interface ArchBasicInfo {
  genre: string;
  theme: string;
  tags: string;
  plannedChapters: string;
  wordsPerChapter: string;
  channel: string;
}

/** 四大架构组类 */
export type ArchGroupKey = 'coreClues' | 'characterDynamics' | 'worldBuilding' | 'plotConstruction';

export interface NovelArchitecture {
  basic: ArchBasicInfo;
  coreClues: ArchEntry[];
  characterDynamics: ArchEntry[];
  worldBuilding: ArchEntry[];
  plotConstruction: ArchEntry[];
}

/** 组类元信息（参考 memory-config 的 GROUP_CONFIG 形态） */
export interface ArchGroupConfig {
  key: ArchGroupKey;
  label: string;
  description: string;
  entryPlaceholder: string;
}

export const ARCH_GROUPS: ArchGroupConfig[] = [
  {
    key: 'coreClues',
    label: '核心线索',
    description: '贯穿全书的主线线索与核心悬念（AIGC 默认注入）',
    entryPlaceholder: '线索标题，如：玉佩背后的身世',
  },
  {
    key: 'characterDynamics',
    label: '角色动力学',
    description: '主要角色的动机、目标、冲突与成长弧线',
    entryPlaceholder: '角色名 / 关系动力，如：林晚 × 沈叙：旧约与亏欠',
  },
  {
    key: 'worldBuilding',
    label: '世界构建',
    description: '世界观规则、势力版图、时代与地点基调',
    entryPlaceholder: '设定名，如：灵潮周期',
  },
  {
    key: 'plotConstruction',
    label: '情节构建',
    description: '分幕结构、关键转折点、高潮与结局设计',
    entryPlaceholder: '节点名，如：中点反转——假死局',
  },
];

const EMPTY_BASIC: ArchBasicInfo = {
  genre: '',
  theme: '',
  tags: '',
  plannedChapters: '',
  wordsPerChapter: '',
  channel: '',
};

const emptyArchitecture = (): NovelArchitecture => ({
  basic: { ...EMPTY_BASIC },
  coreClues: [],
  characterDynamics: [],
  worldBuilding: [],
  plotConstruction: [],
});

const storageKey = (novelId: number) => `inkbloom-architecture-${novelId}`;

const loadPersisted = (novelId: number): NovelArchitecture | null => {
  try {
    const raw = localStorage.getItem(storageKey(novelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NovelArchitecture>;
    return {
      basic: { ...EMPTY_BASIC, ...(parsed.basic ?? {}) },
      coreClues: parsed.coreClues ?? [],
      characterDynamics: parsed.characterDynamics ?? [],
      worldBuilding: parsed.worldBuilding ?? [],
      plotConstruction: parsed.plotConstruction ?? [],
    };
  } catch {
    return null;
  }
};

const persist = (novelId: number, arch: NovelArchitecture) => {
  try {
    localStorage.setItem(storageKey(novelId), JSON.stringify(arch));
  } catch {
    /* 配额不足 / 隐私模式：架构数据仍在内存，本次会话可用 */
  }
};

interface ArchitectureStore {
  byNovel: Record<number, NovelArchitecture>;
  /** 中央架构编辑器的焦点条目（左侧导航点击后打开/定位中央 tab 用，消费后清除） */
  focus: { group: ArchGroupKey; id: string } | null;
  /** 取作品架构（无则初始化；genreFromNovel 用于首次预填流派） */
  ensure: (novelId: number, genreFromNovel?: string) => NovelArchitecture;
  updateBasic: (novelId: number, patch: Partial<ArchBasicInfo>) => void;
  addEntry: (novelId: number, group: ArchGroupKey, title: string) => ArchEntry;
  updateEntry: (novelId: number, group: ArchGroupKey, id: string, patch: Partial<ArchEntry>) => void;
  removeEntry: (novelId: number, group: ArchGroupKey, id: string) => void;
  setFocus: (f: { group: ArchGroupKey; id: string } | null) => void;
  /** 清空某作品架构（删除作品时由调用方触发，可选） */
  reset: (novelId: number) => void;
}

export const useArchitectureStore = create<ArchitectureStore>((set, get) => ({
  byNovel: {},
  focus: null,

  ensure: (novelId, genreFromNovel) => {
    const existing = get().byNovel[novelId];
    if (existing) return existing;
    const persisted = loadPersisted(novelId);
    const arch = persisted ?? emptyArchitecture();
    // 首次初始化：用作品流派预填基本信息（空串才填，不覆盖作者已填内容）
    if (!persisted && genreFromNovel && !arch.basic.genre) {
      arch.basic.genre = genreFromNovel;
    }
    persist(novelId, arch);
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: arch } }));
    return arch;
  },

  updateBasic: (novelId, patch) => {
    const arch = get().ensure(novelId);
    const next = { ...arch, basic: { ...arch.basic, ...patch } };
    persist(novelId, next);
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: next } }));
  },

  addEntry: (novelId, group, title) => {
    const arch = get().ensure(novelId);
    const entry: ArchEntry = { id: crypto.randomUUID(), title: title.trim(), content: '' };
    const next = { ...arch, [group]: [entry, ...arch[group]] };
    persist(novelId, next);
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: next } }));
    return entry;
  },

  updateEntry: (novelId, group, id, patch) => {
    const arch = get().ensure(novelId);
    const next = {
      ...arch,
      [group]: arch[group].map((e) => (e.id === id ? { ...e, ...patch } : e)),
    };
    persist(novelId, next);
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: next } }));
  },

  removeEntry: (novelId, group, id) => {
    const arch = get().ensure(novelId);
    const next = { ...arch, [group]: arch[group].filter((e) => e.id !== id) };
    persist(novelId, next);
    // 焦点条目被删除时一并清除，避免中央编辑器选中悬空条目
    if (get().focus?.id === id) set({ focus: null });
    set((s) => ({ byNovel: { ...s.byNovel, [novelId]: next } }));
  },

  setFocus: (f) => set({ focus: f }),

  reset: (novelId) => {
    try {
      localStorage.removeItem(storageKey(novelId));
    } catch {
      /* ignore */
    }
    set((s) => {
      const next = { ...s.byNovel };
      delete next[novelId];
      return { byNovel: next };
    });
  },
}));

/** 架构摘录序列化（AIGC 卡「架构」线索源）：基本信息 + 各组类条目拼为紧凑文本 */
export function architectureText(novelId: number): string {
  const arch = useArchitectureStore.getState().byNovel[novelId];
  if (!arch) return '';
  const parts: string[] = [];
  const b = arch.basic;
  const basicKv = [
    b.genre && `流派：${b.genre}`,
    b.theme && `主题：${b.theme}`,
    b.tags && `标签：${b.tags}`,
    b.plannedChapters && `规划章节数：${b.plannedChapters}`,
    b.wordsPerChapter && `规划每章字数：${b.wordsPerChapter}`,
    b.channel && `发布渠道：${b.channel}`,
  ].filter(Boolean);
  if (basicKv.length) parts.push(`【基本信息】${basicKv.join('；')}`);
  for (const g of ARCH_GROUPS) {
    const entries = arch[g.key].filter((e) => e.title.trim() || e.content.trim());
    if (!entries.length) continue;
    const body = entries
      .map((e) => `${e.title.trim() || '未命名'}${e.content.trim() ? `：${e.content.trim()}` : ''}`)
      .join('；');
    parts.push(`【${g.label}】${body}`);
  }
  return parts.join('\n');
}
