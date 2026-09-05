/**
 * 工作区快照（备忘录 L61 版本三态 · 浏览器侧）：
 *
 *   发布       —— 服务器第二份文章（published_chapters 冻结副本）
 *   工作区     —— 浏览器本地快照区：自动快照 ×1 + 手动快照 ×2
 *   （草稿正文 —— chapters.content，编辑器防抖与服务器交换，15s 降频）
 *
 * 自动快照时机：回滚到发布版前、AI 全篇/局部改写覆盖前、点击「已完成」时。
 * 手动快照满 2 条后再暂存：UI 弹出替换选择（选中高亮 → 确定替换）。
 * 服务器永不保存这第三份。
 */

export interface WorkspaceSnapshot {
  id: string;
  /** 快照正文 HTML */
  content: string;
  word_count: number;
  saved_at: string;
  /** 产生原因（如「回滚到发布版前」「AI 成章覆盖前」「点击已完成」「手动暂存」） */
  source: string;
}

export interface WorkspaceStore {
  auto: WorkspaceSnapshot | null;
  /** 手动快照，最多 2 条，新的在前 */
  manual: WorkspaceSnapshot[];
}

const KEY = (chapterId: number) => `inkbloom-workspace-${chapterId}`;
export const MANUAL_SLOTS = 2;

export function getWorkspace(chapterId: number): WorkspaceStore {
  try {
    const raw = localStorage.getItem(KEY(chapterId));
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceStore;
      return {
        auto: parsed.auto ?? null,
        manual: Array.isArray(parsed.manual) ? parsed.manual : [],
      };
    }
  } catch {
    /* ignore */
  }
  return { auto: null, manual: [] };
}

function save(chapterId: number, store: WorkspaceStore): void {
  try {
    localStorage.setItem(KEY(chapterId), JSON.stringify(store));
  } catch {
    /* 存储满：静默放弃（不阻断主流程） */
  }
}

function makeSnapshot(content: string, source: string): WorkspaceSnapshot {
  return {
    id: crypto.randomUUID(),
    content,
    word_count: countChinese(content),
    saved_at: new Date().toISOString(),
    source,
  };
}

/** 覆盖自动快照槽（回滚前 / AI 覆盖前 / 点击已完成） */
export function putAutoSnapshot(
  chapterId: number,
  content: string,
  source: string,
): WorkspaceSnapshot {
  const store = getWorkspace(chapterId);
  store.auto = makeSnapshot(content, source);
  save(chapterId, store);
  return store.auto;
}

/** 手动暂存。槽位未满直接放入；已满返回 'full'，由 UI 走替换选择流程 */
export function putManualSnapshot(
  chapterId: number,
  content: string,
  source = '手动暂存',
): 'ok' | 'full' {
  const store = getWorkspace(chapterId);
  if (store.manual.length >= MANUAL_SLOTS) return 'full';
  store.manual = [makeSnapshot(content, source), ...store.manual];
  save(chapterId, store);
  return 'ok';
}

/** 替换指定下标的手动快照（UI 替换选择弹窗确认后调用） */
export function replaceManualSnapshot(
  chapterId: number,
  index: number,
  content: string,
  source = '手动暂存',
): WorkspaceSnapshot {
  const store = getWorkspace(chapterId);
  const snap = makeSnapshot(content, source);
  if (index >= 0 && index < MANUAL_SLOTS) {
    store.manual[index] = snap;
  } else {
    store.manual = [snap, ...store.manual].slice(0, MANUAL_SLOTS);
  }
  save(chapterId, store);
  return snap;
}

export function removeManualSnapshot(chapterId: number, id: string): void {
  const store = getWorkspace(chapterId);
  store.manual = store.manual.filter((e) => e.id !== id);
  save(chapterId, store);
}

export function clearWorkspace(chapterId: number): void {
  try {
    localStorage.removeItem(KEY(chapterId));
  } catch {
    /* ignore */
  }
}

/** 中文字数口径与编辑器一致（仅统计 CJK 字符） */
function countChinese(html: string): number {
  const text = html.replace(/<[^>]+>/g, '');
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}
