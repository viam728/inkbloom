import { create } from 'zustand';
import { fetchMemory, saveMemory, isConflictError } from '@/services/memory-client';
import { toast } from '@/components/common/Toast';

export type MemoryType = 'character' | 'setting' | 'summary' | 'inspiration';

/** 人物关系条目：目标条目（target_id 可选，自由文本时仅 target_name）+ 关系描述 */
export interface MemoryRelation {
  id: string;
  target_id?: string;
  target_name: string;
  relation: string;
  /** 羁绊度 0-100 */
  bond?: number;
  faction?: string;
  note?: string;
}

/** 立绘引用条目：上传或 AI 生成的图片（url 为后端静态资源相对路径，如 /assets/files/...） */
export interface MemoryPortrait {
  id: string;
  url: string;
  thumb_url: string;
  source: 'upload' | 'ai';
  created_at: string;
}

/**
 * AI 访问闸门模式（备忘录：3 软闸 + 3 硬闸）。
 * 软闸：条目仍注入上下文，附带约束指令（ignore 忽略除非明确提及；
 *       restricted/partial 在不可见位置只允许伏笔、隐晦线索铺垫）。
 * 硬闸：位置不符直接不注入（绝不进上下文，绝对的防剧透保证）。
 */
export type MemoryAccessMode =
  | 'ignore'
  | 'restricted_visible'
  | 'partial_visible'
  | 'disabled'
  | 'restricted_disabled'
  | 'partial_disabled';

/** AI 访问闸门配置；缺省 = 无限制（六种闸门全部关闭） */
export interface MemoryAccess {
  mode: MemoryAccessMode;
  /** restricted_*：解锁章（大纲节点 id），该章及以后可见/注入 */
  unlock_chapter_id?: string;
  /** partial_*：精确章节集合（大纲节点 id） */
  visible_chapter_ids?: string[];
}

export interface MemoryItem {
  id: string;
  type: MemoryType;
  name: string;
  content: string;
  tags: string[];
  /** 置顶条目始终排在最前，AI 上下文注入时优先携带 */
  pinned?: boolean;
  /** 分组引导字段值（如人物卡的外表/性格/动机等），键为字段 id */
  fields?: Record<string, string>;
  /** 是否注入 AI 上下文，缺省视为 true（旧字段，读取时迁移进 ai_access） */
  ai_visible?: boolean;
  /** 可见的大纲节点 id，空/缺省 = 全部章节可见（旧章节锁，读取时迁移进 ai_access） */
  visible_chapters?: string[];
  /** AI 访问闸门（3 软闸 + 3 硬闸），缺省 = 无限制 */
  ai_access?: MemoryAccess;
  /** 组内排序（reorderItems 写入） */
  order?: number;
  /** 人物关系（仅人物卡使用，其他分组缺省） */
  relations?: MemoryRelation[];
  /** 立绘图片引用（上传 / AI 生成） */
  portraits?: MemoryPortrait[];
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
  /** 按给定 id 顺序写 order=index，走统一 commit（天然 version 防护） */
  reorderItems: (novelId: number, orderedIds: string[]) => Promise<void>;
}

const persistLocal = (novelId: number, items: MemoryItem[]) => {
  try {
    localStorage.setItem(`inkbloom-memory-${novelId}`, JSON.stringify(items));
  } catch {
    /* ignore */
  }
};

const now = () => new Date().toISOString();

/** 旧排序语义（pinned 优先 + updated_at 倒序），仅供归一化回填 order 使用 */
function legacySort(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
  });
}

const MEMORY_TYPES: MemoryType[] = ['character', 'setting', 'summary', 'inspiration'];

/**
 * 旧字段迁移（幂等）：ai_visible=false → disabled 硬闸；非空 visible_chapters →
 * partial_visible（旧"任一完成即全局解锁"语义收紧为按写作位置求值）。已有
 * ai_access 的条目原样保留——与新字段并存的旧字段不再生效。
 */
export function normalizeAccess(
  i: Pick<MemoryItem, 'ai_access' | 'ai_visible' | 'visible_chapters'>,
): MemoryAccess | undefined {
  if (i.ai_access?.mode) return i.ai_access;
  if (i.ai_visible === false) return { mode: 'disabled' };
  if (i.visible_chapters?.length) {
    return { mode: 'partial_visible', visible_chapter_ids: [...i.visible_chapters] };
  }
  return undefined;
}

/**
 * 归一化记忆条目（幂等）：
 * 1. 补齐遗留/外部导入数据缺失的必备字段（id / type / name / tags）：
 *    后端 media_memory 等存储可能只含 name+content（如 per-user 改造前的全局遗留行），
 *    缺失字段直接进渲染会因 undefined.forEach 等抛运行时异常导致白屏；
 * 2. 非 HTML 的旧纯文本 content 包 <p>（以 < 开头且含 > 视为 HTML，空内容保持空）；
 * 3. 缺 order 的按旧排序结果回填 index。
 */
export function normalizeMemoryItems(items: MemoryItem[]): MemoryItem[] {
  const withRequired = items.map((i) => ({
    ...i,
    id: i.id ?? crypto.randomUUID(),
    type: MEMORY_TYPES.includes(i.type) ? i.type : 'character',
    name: i.name ?? '',
    tags: Array.isArray(i.tags) ? i.tags : [],
    ai_access: normalizeAccess(i),
  }));
  const withHtml = withRequired.map((i) => {
    const c = i.content ?? '';
    const trimmed = c.trim();
    if (trimmed === '') return i;
    const isHtml = trimmed.startsWith('<') && c.includes('>');
    if (isHtml) return i;
    const escaped = c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { ...i, content: `<p>${escaped}</p>` };
  });
  return legacySort(withHtml).map((i, idx) => (i.order === undefined ? { ...i, order: idx } : i));
}

/** per-novel 单调请求序号：丢弃过期的 loadMemory 响应，避免快速切换作品时旧请求覆盖新数据 */
const loadSeq = new Map<number, number>();

/** 服务端版本号（不进入 byNovel 状态形状，保持消费方兼容） */
const versions = new Map<number, number>();

/** 后端同步失败提示节流：同一作品 10s 内不重复弹 toast */
const lastFailToast = new Map<number, number>();

const toastBackendFail = (novelId: number) => {
  const t = Date.now();
  if (t - (lastFailToast.get(novelId) ?? 0) < 10_000) return;
  lastFailToast.set(novelId, t);
  toast.show('已保存到本地，稍后将同步', 'info');
};

export const useMemoryStore = create<MemoryState>((set, get) => ({
  byNovel: {},
  loading: false,
  saving: false,

  loadMemory: async (novelId) => {
    const seq = (loadSeq.get(novelId) ?? 0) + 1;
    loadSeq.set(novelId, seq);
    set({ loading: true });
    try {
      const { items, version } = await fetchMemory(novelId);
      // 过期响应丢弃：已有更新的请求发出
      if (seq !== loadSeq.get(novelId)) return;
      versions.set(novelId, version);
      set((s) => ({ byNovel: { ...s.byNovel, [novelId]: normalizeMemoryItems(items) } }));
    } catch {
      if (seq !== loadSeq.get(novelId)) return;
      // 后端不可用时回退本地缓存（含旧键兼容迁移）
      try {
        const raw = localStorage.getItem(`inkbloom-memory-${novelId}`);
        const items: MemoryItem[] = raw ? JSON.parse(raw) : [];
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: normalizeMemoryItems(items) } }));
      } catch {
        set((s) => ({ byNovel: { ...s.byNovel, [novelId]: [] } }));
      }
    } finally {
      if (seq === loadSeq.get(novelId)) set({ loading: false });
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

  reorderItems: async (novelId, orderedIds) => {
    const indexOf = new Map(orderedIds.map((id, idx) => [id, idx]));
    await commit(set, get, novelId, (items) =>
      items.map((i) => {
        const idx = indexOf.get(i.id);
        return idx === undefined ? i : { ...i, order: idx };
      }),
    );
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
    const result = await saveMemory(novelId, items, versions.get(novelId));
    versions.set(novelId, result.version);
  } catch (e) {
    if (isConflictError(e)) {
      // 版本冲突：其他端已更新，重新拉取并提示
      toast.show('记忆已被其他端更新，已刷新', 'info');
      void get().loadMemory(novelId);
    } else {
      /* 后端不可用，仅本地保存并提示一次 */
      toastBackendFail(novelId);
    }
  } finally {
    set(() => ({ saving: false }));
  }
}

/** 置顶优先 → order 升序（缺省视为大值排后）→ updated_at 倒序兜底 */
export function sortMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
  });
}
