import type { Novel, Chapter } from '@/types';

/**
 * ═══ 本地降级数据层（仅 DEV） ═══════════════════════════════════════════
 *
 * 后端未启动时，作品 / 章节 / 内容的 CRUD 降级为 localStorage，
 * 保证「作品 → 大纲 → 成稿」全链路在无后端环境可完整演示。
 * 后端就绪后该层自动失效（仅在请求失败且 DEV 环境时启用）。
 * ══════════════════════════════════════════════════════════════════════
 */

const NKEY = 'inkbloom-local-novels';
const CKEY = 'inkbloom-local-chapters';
const contentKey = (id: number) => `inkbloom-local-content-${id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const now = () => new Date().toISOString();

// ── 作品 ────────────────────────────────────────────────────────────────
export function localNovels(): Novel[] {
  return read<Novel[]>(NKEY, []);
}

export function createLocalNovel(data: {
  title: string;
  genre?: string;
  description?: string;
}): Novel {
  const novel: Novel = {
    id: Date.now(),
    title: data.title,
    genre: data.genre,
    description: data.description,
    status: 'active',
    word_count: 0,
    created_at: now(),
    updated_at: now(),
  };
  write(NKEY, [novel, ...localNovels()]);
  return novel;
}

export function removeLocalNovel(id: number) {
  write(NKEY, localNovels().filter((n) => n.id !== id));
  // 级联删除其章节与内容
  const all = read<Record<string, Chapter[]>>(CKEY, {});
  const chapters = all[id] ?? [];
  chapters.forEach((c) => localStorage.removeItem(contentKey(c.id)));
  delete all[id];
  write(CKEY, all);
}

// ── 章节 ────────────────────────────────────────────────────────────────
export function localChapters(novelId: number): Chapter[] {
  const all = read<Record<string, Chapter[]>>(CKEY, {});
  return all[novelId] ?? [];
}

function writeChapters(novelId: number, chapters: Chapter[]) {
  const all = read<Record<string, Chapter[]>>(CKEY, {});
  all[novelId] = chapters;
  write(CKEY, all);
}

export function createLocalChapter(data: {
  novel_id: number;
  title: string;
  content?: string;
  /** 插入位置（0 基），缺省追加到末尾 */
  position?: number;
}): Chapter {
  const existing = localChapters(data.novel_id);
  const chapter: Chapter = {
    id: Date.now(),
    novel_id: data.novel_id,
    title: data.title,
    word_count: data.content ? data.content.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length : 0,
    sort_order: 0,
    created_at: now(),
    updated_at: now(),
  };
  const next = [...existing];
  const at =
    data.position == null || data.position >= next.length
      ? next.length
      : Math.max(0, data.position);
  next.splice(at, 0, chapter);
  writeChapters(data.novel_id, normalizeOrder(next));
  if (data.content) setLocalContent(chapter.id, data.content);
  return chapter;
}

export function updateLocalChapter(id: number, patch: Partial<Chapter>) {
  const all = read<Record<string, Chapter[]>>(CKEY, {});
  Object.keys(all).forEach((key) => {
    all[key] = all[key].map((c) =>
      c.id === id ? { ...c, ...patch, updated_at: now() } : c,
    );
  });
  write(CKEY, all);
}

/** 按传入 id 顺序重写章节序列（拖拽排序持久化） */
export function reorderLocalChapters(novelId: number, orderedIds: number[]) {
  const current = localChapters(novelId);
  const byId = new Map(current.map((c) => [c.id, c]));
  const next: Chapter[] = [];
  orderedIds.forEach((id) => {
    const c = byId.get(id);
    if (c) {
      next.push(c);
      byId.delete(id);
    }
  });
  // 未出现在排序中的章节保持末尾
  byId.forEach((c) => next.push(c));
  writeChapters(novelId, normalizeOrder(next));
}

function normalizeOrder(chapters: Chapter[]): Chapter[] {
  return chapters.map((c, i) => ({ ...c, sort_order: i + 1 }));
}

export function removeLocalChapter(id: number) {
  const all = read<Record<string, Chapter[]>>(CKEY, {});
  Object.keys(all).forEach((key) => {
    all[key] = all[key].filter((c) => c.id !== id);
  });
  write(CKEY, all);
  localStorage.removeItem(contentKey(id));
}

// ── 章节内容 ─────────────────────────────────────────────────────────────
export function getLocalContent(chapterId: number): string {
  try {
    return localStorage.getItem(contentKey(chapterId)) ?? '';
  } catch {
    return '';
  }
}

export function setLocalContent(chapterId: number, content: string) {
  try {
    localStorage.setItem(contentKey(chapterId), content);
  } catch {
    /* ignore */
  }
}
