import apiClient from './api-client';
import type { OutlineAct } from '@/stores/outline-store';

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

export async function fetchOutline(novelId: number): Promise<OutlineAct[]> {
  const data = (await apiClient.get(`/novels/${novelId}/outline`)) as unknown as {
    acts?: OutlineAct[];
  };
  return data?.acts ?? (Array.isArray(data) ? (data as unknown as OutlineAct[]) : []);
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
