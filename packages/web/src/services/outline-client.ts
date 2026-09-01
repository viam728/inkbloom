import apiClient from './api-client';
import type { OutlineAct, OutlineNode, OutlineStatus } from '@/stores/outline-store';

/**
 * ═══ 结构化创作服务层（后端预留对接） ═════════════════════════════════════
 *
 * 预留端点契约（待 server/ai-service 实现）：
 *
 * 1. GET  /novels/:id/outline        → { acts: OutlineAct[] }
 *    PUT  /novels/:id/outline        req: { acts: OutlineAct[] }
 *
 * 2. POST /ai/expand-outline
 *    req:  { outline_title: string; summary: string; memory_context?: string[];
 *            target_words?: number }
 *    resp: { draft: string }   // 成稿初稿（HTML 段落）
 *
 * 后端未就绪时：大纲读写降级 localStorage（store 层处理），
 * 扩写降级为本地模板生成，保证「大纲 → 成稿」链路可演示。
 * ══════════════════════════════════════════════════════════════════════
 */

// ── 大纲数据规范化 ─────────────────────────────────────────────────────
// 后端 acts 是自由结构的 JSON：历史脏数据、Agent 写入的残缺结构、localStorage
// 里的旧缓存都可能缺少 id / nodes / status。渲染层（OutlinePanel 等）会无条件
// 解引用 act.nodes、拿 node.status 查表，任一处拿到 undefined 就抛 TypeError
// 并白屏。这里在入口处把任意形状强制收敛成 OutlineAct[] 契约形状。
// ─────────────────────────────────────────────────────────────────────

const OUTLINE_STATUSES: readonly OutlineStatus[] = ['planned', 'drafting', 'done'];

/** 生成节点 id；crypto.randomUUID 不可用时（非安全上下文）退化为随机串 */
const newOutlineId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `oid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 任意值 → 字符串（非字符串一律空串） */
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const isOutlineStatus = (v: unknown): v is OutlineStatus =>
  typeof v === 'string' && (OUTLINE_STATUSES as readonly string[]).includes(v);

/** 把一个任意值收敛为合法的 OutlineNode；非对象返回 null（丢弃该条） */
export function normalizeOutlineNode(raw: unknown): OutlineNode | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const node: OutlineNode = {
    id: asString(o.id).trim() || newOutlineId(),
    title: asString(o.title),
    // summary 存的是 HTML 片段，原样保留，不做转义或清洗
    summary: asString(o.summary),
    status: isOutlineStatus(o.status) ? o.status : 'planned',
  };
  if (typeof o.chapter_id === 'number' && Number.isFinite(o.chapter_id)) {
    node.chapter_id = o.chapter_id;
  }
  if (Array.isArray(o.memory_refs)) {
    node.memory_refs = o.memory_refs.filter((r): r is string => typeof r === 'string');
  }
  return node;
}

/** 把一个任意值收敛为合法的 OutlineAct；非对象返回 null（丢弃该幕） */
export function normalizeOutlineAct(raw: unknown): OutlineAct | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const nodes: OutlineNode[] = [];
  // nodes 缺失或非数组时兜底为空数组，保证 act.nodes 恒可安全解引用
  if (Array.isArray(o.nodes)) {
    for (const item of o.nodes) {
      const node = normalizeOutlineNode(item);
      if (node) nodes.push(node);
    }
  }
  return {
    id: asString(o.id).trim() || newOutlineId(),
    title: asString(o.title),
    nodes,
  };
}

/** 把后端 / localStorage 返回的任意形状强制收敛为 OutlineAct[] */
export function normalizeOutlineActs(raw: unknown): OutlineAct[] {
  if (!Array.isArray(raw)) return [];
  const acts: OutlineAct[] = [];
  for (const item of raw) {
    const act = normalizeOutlineAct(item);
    if (act) acts.push(act);
  }
  return acts;
}

export async function fetchOutline(novelId: number): Promise<OutlineAct[]> {
  const data = (await apiClient.get(`/novels/${novelId}/outline`)) as unknown as {
    acts?: unknown;
  };
  // 零信任后端形状：统一收敛后再交給 store，渲染层便不可能因脏数据抛错
  return normalizeOutlineActs(data?.acts ?? data);
}

export async function saveOutline(novelId: number, acts: OutlineAct[]): Promise<void> {
  await apiClient.put(`/novels/${novelId}/outline`, { acts });
}

// ── 大纲扩写：从剧情要点生成章节初稿 ─────────────────────────────────────
export interface ExpandOutlineInput {
  outlineTitle: string;
  summary: string;
  /** 作品记忆（人物/设定）上下文，用于保持成稿一致性 */
  memoryContext?: string[];
  targetWords?: number;
}

export async function expandOutlineToDraft(input: ExpandOutlineInput): Promise<string> {
  try {
    const data = (await apiClient.post('/ai/expand-outline', {
      outline_title: input.outlineTitle,
      summary: input.summary,
      memory_context: input.memoryContext,
      target_words: input.targetWords,
    })) as unknown as { draft?: string };
    if (data?.draft) return data.draft;
    throw new Error('empty draft');
  } catch (e) {
    if (!import.meta.env.DEV) throw e;
    return mockExpand(input);
  }
}

/** 本地模板式 mock：把剧情要点扩写成带场景描写的初稿段落 */
function mockExpand(input: ExpandOutlineInput): Promise<string> {
  const beats = input.summary
    .split(/\n+/)
    .map((b) => b.replace(/^[-·•*\d.\s]+/, '').trim())
    .filter(Boolean);

  const memoryLine = input.memoryContext?.length
    ? `<p>（本段写作已参考设定：${input.memoryContext.join('、')}）</p>`
    : '';

  const sections = beats.length
    ? beats
    : [input.summary.trim() || '故事从这里开始。'];

  const paragraphs = sections.flatMap((beat, i) => {
    const openers = [
      `夜色落下来的时候，${beat}。`,
      `事情的转折，恰恰发生在${beat}的那一刻。`,
      `没有人预料到，${beat}。`,
      `直到此刻才明白，所谓命运，不过是${beat}。`,
    ];
    const middles = [
      '空气里浮动着一种说不清道不明的预感，仿佛下一秒，所有隐藏的答案都会浮出水面。',
      '他深吸一口气，把翻涌的心绪压了下去。接下来要做的每一步，都不允许出错。',
      '远处传来模糊的声响，像是什么东西正在悄然改变，又像是某种迟来的回应。',
    ];
    return [
      `<p>${openers[i % openers.length]}</p>`,
      `<p>${middles[i % middles.length]}</p>`,
    ];
  });

  const closing =
    '<p>一切仍在继续。而这，不过是整个故事的开始。（AI 初稿 · 请在此基础上润色成稿）</p>';

  return Promise.resolve(
    `<h2>${input.outlineTitle || '未命名章节'}</h2>${memoryLine}${paragraphs.join('')}${closing}`,
  );
}
