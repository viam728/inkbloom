import apiClient from './api-client';
import type { Chapter } from '@/types';
import type { OutlineAct } from '@/stores/outline-store';
import type { MemoryItem } from '@/stores/memory-store';
import type { MediaContent } from '@/types/media';
import { PLATFORMS } from '@/types/media';

/**
 * ═══ 作品整体分析服务层（后端预留对接） ═════════════════════════════════
 *
 * 预留端点契约（待 server/ai-service 实现）：
 *   POST /ai/analyze-story    小说整体分析
 *   POST /ai/analyze-media    自媒体内容分析
 *
 * 后端未就绪时，前端用启发式规则本地估算，保证分析面板可完整演示。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface AnalysisDimension {
  label: string;
  score: number; // 0-100
  tip: string;
}

export interface AnalysisReport {
  score: number; // 0-100 综合评分
  summary: string;
  dimensions: AnalysisDimension[];
  suggestions: string[];
  generatedAt: string;
}

// ── 工具 ────────────────────────────────────────────────────────────────
const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const countWords = (text: string) => {
  const plain = stripHtml(text || '');
  const cn = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (plain.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function stddev(nums: number[]): number {
  if (!nums.length) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

// ── 小说整体分析 ────────────────────────────────────────────────────────
export interface StoryAnalysisInput {
  title: string;
  chapters: Chapter[];
  outline: OutlineAct[];
  memory: MemoryItem[];
}

export async function analyzeStory(input: StoryAnalysisInput): Promise<AnalysisReport> {
  try {
    const data = (await apiClient.post('/ai/analyze-story', {
      title: input.title,
      chapter_count: input.chapters.length,
      total_words: input.chapters.reduce((a, c) => a + (c.word_count ?? 0), 0),
      outline_acts: input.outline.length,
      outline_nodes: input.outline.reduce((a, act) => a + act.nodes.length, 0),
      characters: input.memory.filter((m) => m.type === 'character').length,
    })) as unknown as AnalysisReport;
    if (data && typeof data.score === 'number') return data;
    throw new Error('empty analysis');
  } catch (e) {
    if (!import.meta.env.DEV) throw e;
    return localStoryAnalysis(input);
  }
}

/** 本地启发式分析：结构 / 人物 / 节奏 / 篇幅 */
function localStoryAnalysis(input: StoryAnalysisInput): AnalysisReport {
  const { chapters, outline, memory } = input;
  const dimensions: AnalysisDimension[] = [];
  const suggestions: string[] = [];

  const totalWords = chapters.reduce((a, c) => a + (c.word_count ?? 0), 0);
  const counts = chapters.map((c) => c.word_count ?? 0);
  const avg = counts.length ? totalWords / counts.length : 0;
  const sd = stddev(counts);

  // 1. 篇幅与结构
  const acts = outline.length;
  const nodes = outline.reduce((a, act) => a + act.nodes.length, 0);
  const doneNodes = outline.reduce(
    (a, act) => a + act.nodes.filter((n) => n.status === 'done').length,
    0,
  );
  const structureScore = clamp(
    (acts >= 3 ? 40 : acts * 12) + (nodes > 0 ? Math.min(30, nodes * 4) : 0),
  );
  dimensions.push({
    label: '结构完整度',
    score: structureScore,
    tip:
      acts < 3
        ? '建议按「三幕式」搭建：铺垫 → 冲突升级 → 高潮收束，目前幕数偏少。'
        : '三幕骨架已具备，可继续细化每幕的转折点。',
  });

  // 2. 进度推进
  const progressScore = nodes > 0 ? clamp((doneNodes / nodes) * 100) : totalWords > 0 ? 40 : 0;
  dimensions.push({
    label: '大纲推进度',
    score: progressScore,
    tip:
      nodes === 0
        ? '还没有大纲节点，先在大纲面板规划章节要点。'
        : `${doneNodes}/${nodes} 个要点已成稿，保持节奏继续推进。`,
  });

  // 3. 节奏均衡（章节字数离散度）
  const balance = counts.length >= 2 ? clamp(100 - (sd / (avg || 1)) * 60) : 60;
  dimensions.push({
    label: '篇幅均衡度',
    score: balance,
    tip:
      counts.length < 2
        ? '章节太少，暂时无法评估节奏，先多写几章。'
        : balance < 50
          ? '各章字数差异较大，注意节奏起伏是否服务于剧情张力。'
          : '章节篇幅较为均衡，阅读节奏稳定。',
  });

  // 4. 人物厚度
  const characters = memory.filter((m) => m.type === 'character');
  const settings = memory.filter((m) => m.type === 'setting');
  const charScore = clamp(characters.length * 20 + (settings.length ? 10 : 0));
  dimensions.push({
    label: '人物与设定',
    score: charScore,
    tip: characters.length
      ? `已建立 ${characters.length} 个人物卡${settings.length ? `、${settings.length} 个设定` : ''}，写作时可随时引用。`
      : '还没有人物卡，在「记忆」面板补充角色设定，AI 扩写会更贴合人物。',
  });

  const score = clamp(
    structureScore * 0.3 + progressScore * 0.3 + balance * 0.2 + charScore * 0.2,
  );

  if (chapters.length === 0) suggestions.push('先创建第一章，把故事真正开始写起来。');
  if (acts === 0) suggestions.push('在大纲面板划分幕结构，让长篇有清晰的推进目标。');
  if (!characters.length) suggestions.push('为核心角色建立人物卡，AI 扩写会更一致。');
  if (balance < 50 && counts.length >= 2)
    suggestions.push('检查过长或过短的章节，必要时拆分或扩写以稳定节奏。');
  if (!suggestions.length) suggestions.push('整体状态良好，继续保持当前的创作节奏。');

  return {
    score,
    summary:
      chapters.length === 0
        ? '这是一部刚起步的作品。先搭建大纲、建立人物卡，再落笔第一章，会让后续写作顺畅很多。'
        : `《${input.title}》已有 ${chapters.length} 章、约 ${totalWords.toLocaleString()} 字。结构${
            acts ? `分为 ${acts} 幕` : '尚未分幕'
          }，人物设定 ${characters.length} 项。整体推进${
            progressScore >= 60 ? '顺利' : '仍有较大空间'
          }。`,
    dimensions,
    suggestions,
    generatedAt: new Date().toISOString(),
  };
}

// ── 自媒体内容分析 ──────────────────────────────────────────────────────
export async function analyzeMedia(content: MediaContent): Promise<AnalysisReport> {
  try {
    const data = (await apiClient.post('/ai/analyze-media', {
      title: content.title,
      content: content.content,
      platform: content.platform,
    })) as unknown as AnalysisReport;
    if (data && typeof data.score === 'number') return data;
    throw new Error('empty analysis');
  } catch (e) {
    if (!import.meta.env.DEV) throw e;
    return localMediaAnalysis(content);
  }
}

function localMediaAnalysis(content: MediaContent): AnalysisReport {
  const meta = PLATFORMS.find((p) => p.id === content.platform);
  const max = meta?.maxWords ?? 1000;
  const plain = stripHtml(content.content);
  const words = countWords(content.content);
  const dims: AnalysisDimension[] = [];

  // 字数匹配
  const lenScore =
    words === 0 ? 0 : words <= max ? clamp(60 + (words / max) * 40) : clamp(100 - ((words - max) / max) * 80);
  dims.push({
    label: '篇幅适配',
    score: lenScore,
    tip:
      words === 0
        ? '正文还是空的，先写点内容。'
        : words > max
          ? `当前 ${words} 字，超出${meta?.label ?? '平台'}建议的 ${max} 字，建议精简。`
          : `${words} / ${max} 字，篇幅合适。`,
  });

  // 标题
  const titleLen = content.title.trim().length;
  const titleScore = titleLen === 0 ? 0 : titleLen >= 6 && titleLen <= 24 ? 90 : 60;
  dims.push({
    label: '标题吸引力',
    score: titleScore,
    tip:
      titleLen === 0
        ? '还没有标题，可在「标题工厂」一键生成。'
        : titleLen > 24
          ? '标题偏长，控制在 24 字内更利于展示。'
          : '标题长度适中，可用数字/疑问句进一步提升点击。',
  });

  // 标签
  const tagScore = clamp(content.tags.length * 25);
  dims.push({
    label: '标签覆盖',
    score: tagScore,
    tip: content.tags.length
      ? `已有 ${content.tags.length} 个标签，利于分发曝光。`
      : '还没有标签，添加话题标签能显著提升曝光。',
  });

  // 互动钩子（emoji / 疑问句）
  const emoji = (plain.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const hooks = (plain.match(/[?？]/g) || []).length;
  const hookScore = clamp(emoji * 10 + hooks * 15);
  dims.push({
    label: '互动钩子',
    score: hookScore,
    tip:
      hookScore < 40
        ? '可以加入 emoji 或一个提问句，引导读者评论互动。'
        : '互动元素充足，能有效提升评论与转发。',
  });

  const score = clamp(dims.reduce((a, d) => a + d.score, 0) / dims.length);
  return {
    score,
    summary: `《${content.title || '未命名内容'}》面向${meta?.label ?? '通用'}平台，当前 ${words} 字。整体${
      score >= 70 ? '接近可发布状态' : '还有优化空间'
    }。`,
    dimensions: dims,
    suggestions:
      score >= 80
        ? ['内容状态良好，可直接进入发布流程。']
        : ['补全标题与标签，并使用「平台改写」适配目标平台语气。'],
    generatedAt: new Date().toISOString(),
  };
}
