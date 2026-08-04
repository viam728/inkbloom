import apiClient from './api-client';
import type { Chapter } from '@/types';

/**
 * 剧情节奏服务（后端预留对接）
 *
 * 预留端点契约：
 *   GET /novels/:id/rhythm → { points: Array<{ chapter_id: number; score: number }> }
 *   score ∈ [0, 100]，表示该章节的张力/节奏强度（由 ai-service 语义分析得出）
 *
 * 后端未就绪时，前端使用启发式规则本地估算。
 */

export interface RhythmPoint {
  chapterId: number;
  title: string;
  score: number;
  /** 是否为本地估算（非服务端语义分析） */
  estimated: boolean;
}

export async function fetchServerRhythm(novelId: number): Promise<Map<number, number> | null> {
  try {
    const data = (await apiClient.get(`/novels/${novelId}/rhythm`)) as unknown as {
      points?: { chapter_id: number; score: number }[];
    };
    if (!data?.points?.length) return null;
    return new Map(data.points.map((p) => [p.chapter_id, p.score]));
  } catch {
    return null;
  }
}

/** 启发式张力估算：对话密度 + 感叹/疑问密度 + 短句比例 */
function heuristicScore(text: string): number {
  const plain = text.replace(/<[^>]+>/g, '');
  if (!plain.trim()) return 30;

  const dialogueChars = (plain.match(/[「」『』"“”]/g) || []).length;
  const exclaim = (plain.match(/[！？!?…]/g) || []).length;
  const sentences = plain.split(/[。！？!?]/).filter((s) => s.trim());
  const shortRatio = sentences.length
    ? sentences.filter((s) => s.trim().length < 15).length / sentences.length
    : 0;

  const dialogueDensity = Math.min(1, dialogueChars / Math.max(1, plain.length / 4));
  const exclaimDensity = Math.min(1, exclaim / Math.max(1, plain.length / 80));

  const score = 25 + dialogueDensity * 35 + exclaimDensity * 25 + shortRatio * 15;
  return Math.round(Math.min(100, score));
}

/** 综合计算全书节奏：优先服务端数据，缺失章节用本地启发式补齐 */
export function computeRhythm(
  chapters: Chapter[],
  serverScores: Map<number, number> | null,
): RhythmPoint[] {
  return chapters.map((c, idx) => {
    const serverScore = serverScores?.get(c.id);
    if (serverScore !== undefined) {
      return { chapterId: c.id, title: c.title, score: serverScore, estimated: false };
    }
    if (c.content && c.content.trim()) {
      return { chapterId: c.id, title: c.title, score: heuristicScore(c.content), estimated: true };
    }
    // 无内容时按字数给出基线估算，保证图表连续
    const wc = c.word_count ?? 0;
    const base = wc > 0 ? 35 + Math.min(25, wc / 200) + ((idx * 13) % 15) : 20;
    return { chapterId: c.id, title: c.title, score: Math.round(base), estimated: true };
  });
}
