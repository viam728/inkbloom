import apiClient from './api-client';
import type { ReviewAnnotation, ReviewSeverity } from '@/stores/review-store';

/**
 * ═══ AI 动作服务层（后端预留对接） ═══════════════════════════════════════
 *
 * 预留端点契约（待 server/ai-service 实现）：
 *
 * 1. POST /ai/candidates
 *    req:  { action: string; context: string; model?: string; n?: number }
 *    resp: { candidates: string[] }
 *
 * 2. POST /ai/review
 *    req:  { chapter_id: number; text: string }
 *    resp: { annotations: Array<{ quote, comment, suggestion?, severity }> }
 *
 * 3. POST /ai/inspiration
 *    req:  { category: 'plot'|'conflict'|'whatif'|'character'; context?: string }
 *    resp: { items: string[] }
 *
 * 后端未就绪时，开发环境自动降级为本地 mock 数据，保证交互链路可演示。
 * ══════════════════════════════════════════════════════════════════════
 */

export type AIAction = 'continue' | 'polish' | 'expand' | 'condense' | 'dialogue';

export const AI_ACTION_LABELS: Record<AIAction, string> = {
  continue: '续写',
  polish: '润色',
  expand: '扩写',
  condense: '缩写',
  dialogue: '续写对话',
};

const DEV_MOCK = import.meta.env.DEV;

// ── 多候选生成（N 选 1） ─────────────────────────────────────────────────
export async function generateCandidates(
  action: AIAction,
  context: string,
  model?: string,
  n = 3,
): Promise<string[]> {
  try {
    const data = (await apiClient.post('/ai/candidates', {
      action,
      context,
      model,
      n,
    })) as unknown as { candidates: string[] };
    if (data?.candidates?.length) return data.candidates;
    throw new Error('empty candidates');
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return mockCandidates(action, context);
  }
}

function mockCandidates(action: AIAction, context: string): Promise<string[]> {
  const tail = context.replace(/\s+/g, ' ').slice(-40);
  const templates: Record<AIAction, string[]> = {
    continue: [
      `……${tail || '夜色渐深'}，远处的灯火忽然暗了下去，一种说不清的预感攥住了他的心。（候选 A：悬念走向）`,
      `她沉默片刻，终于开口："其实，那天的事，我一直没有告诉你真相。"（候选 B：对话揭秘）`,
      `风卷着落叶掠过街道，他加快脚步，拐进了那家熟悉的旧书店。（候选 C：场景转换）`,
    ],
    polish: [
      `${tail || '原句'} —— 月色像一层薄纱，轻轻覆在沉默的屋檐上。（更抒情）`,
      `${tail || '原句'} —— 月光落下来，屋檐不说话。（更凝练）`,
      `${tail || '原句'} —— 清冷的月光漫过屋檐，仿佛连时间都放慢了呼吸。（更细腻）`,
    ],
    expand: [
      `他站在原地，脑海里翻涌起无数画面：童年的巷口、母亲的叮咛、那个雨夜仓促的告别……每一个画面都在催促他做出决定。`,
      `房间里的空气仿佛凝固了。墙上的挂钟滴答作响，每一声都像敲在心口。他知道，接下来的一句话，将改变所有人的命运。`,
      `她低头看着手中的信纸，指尖微微发抖。信上的字迹熟悉又陌生，仿佛来自另一个时空。`,
    ],
    condense: [
      `他犹豫片刻，终究还是推开了门。`,
      `月光下，两人相对无言。`,
      `一切已成定局。`,
    ],
    dialogue: [
      `"你终于来了。"她背对着他，声音很轻，"我等了很久。"\n"有些事，必须当面说清楚。"他握紧了手里的信封。`,
      `"如果我说不知道，你信吗？"\n"不信。"他盯着对方的眼睛，"从那天起，你每一句话我都不信。"`,
      `"走吧，这里已经不安全了。"\n"可东西还没找到。"\n"命都没了，要东西做什么？"`,
    ],
  };
  return Promise.resolve(templates[action]);
}

// ── AI 批注评审 ─────────────────────────────────────────────────────────
export async function requestReview(
  chapterId: number,
  text: string,
): Promise<Omit<ReviewAnnotation, 'resolved'>[]> {
  try {
    const data = (await apiClient.post('/ai/review', {
      chapter_id: chapterId,
      text,
    })) as unknown as { annotations: Omit<ReviewAnnotation, 'resolved' | 'id'>[] };
    if (data?.annotations) {
      return data.annotations.map((a) => ({ ...a, id: crypto.randomUUID() }));
    }
    throw new Error('empty annotations');
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return mockReview(text);
  }
}

/** 本地规则式 mock：从正文中抽取段落生成示例批注 */
function mockReview(text: string): Omit<ReviewAnnotation, 'resolved'>[] {
  const plain = text.replace(/<[^>]+>/g, '');
  const paragraphs = plain
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 15);

  const results: Omit<ReviewAnnotation, 'resolved'>[] = [];
  const push = (quote: string, comment: string, severity: ReviewSeverity, suggestion?: string) =>
    results.push({ id: crypto.randomUUID(), quote, comment, severity, suggestion });

  if (paragraphs.length === 0) {
    return results;
  }

  const first = paragraphs[0];
  push(first.slice(0, 30), '开篇代入感不错，建议在前 200 字内抛出核心悬念，留住读者。', 'suggestion');

  const longP = paragraphs.find((p) => p.length > 200);
  if (longP) {
    push(
      longP.slice(0, 30),
      '这一段超过 200 字且缺少对话，阅读节奏偏慢，建议拆分或插入互动。',
      'issue',
      '尝试在段落中间插入一句对话或动作描写，切开信息密度。',
    );
  }

  const dialogueP = paragraphs.find((p) => /["「『]/.test(p));
  if (dialogueP) {
    push(dialogueP.slice(0, 30), '对话推进自然，人物语气有区分度，保持这个状态。', 'praise');
  }

  if (paragraphs.length > 3) {
    const last = paragraphs[paragraphs.length - 1];
    push(last.slice(0, 30), '结尾可以埋一个钩子（未解的问题/突发的变故），提升追读率。', 'suggestion');
  }

  return results.slice(0, 5);
}

// ── 灵感急救包 ──────────────────────────────────────────────────────────
export type InspirationCategory = 'plot' | 'conflict' | 'whatif' | 'character';

export const INSPIRATION_LABELS: Record<InspirationCategory, string> = {
  plot: '剧情走向',
  conflict: '冲突点子',
  whatif: '如果……会怎样',
  character: '角色事件',
};

export async function fetchInspiration(
  category: InspirationCategory,
  context?: string,
): Promise<string[]> {
  try {
    const data = (await apiClient.post('/ai/inspiration', { category, context })) as unknown as {
      items: string[];
    };
    if (data?.items?.length) return data.items;
    throw new Error('empty inspiration');
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return mockInspiration(category);
  }
}

const INSPIRATION_BANK: Record<InspirationCategory, string[]> = {
  plot: [
    '主角发现一直帮助的陌生人，竟是当年惨案的目击者',
    '一封寄错地址的信，揭开了两代人隐藏的身份',
    '关键道具在最信任的人手中被发现',
    '主角被迫与宿敌合作，对抗更大的威胁',
    '一场意外让主角获得了死者生前的记忆碎片',
  ],
  conflict: [
    '两个至亲的人立场对立，主角必须选边',
    '主角的承诺与真相互相矛盾，说哪个都会失去重要的人',
    '团队中出现了内鬼，而所有证据指向最不可能的人',
    '主角的能力越强，代价就越大，这次代价是他最珍视的东西',
    '旧日恩人成了今日对手，恩情与正义如何取舍',
  ],
  whatif: [
    '如果主角当年没有离开故乡，现在的一切还会发生吗？',
    '如果反派其实是正确的，主角的信念会崩塌吗？',
    '如果这个世界每个人都说谎，只有主角能听到真话？',
    '如果主角的超能力会在午夜消失一小时？',
    '如果死去的人每年可以回来一天？',
  ],
  character: [
    '让角色收到十年前自己写的一封信',
    '让角色在雨夜偶遇童年时的自己',
    '让角色被迫当众说出藏了最久的秘密',
    '让角色接手一份不属于他的遗物',
    '让角色在异乡听到有人哼着家乡的童谣',
  ],
};

function mockInspiration(category: InspirationCategory): Promise<string[]> {
  const bank = INSPIRATION_BANK[category];
  const shuffled = [...bank].sort(() => Math.random() - 0.5);
  return Promise.resolve(shuffled.slice(0, 3));
}

// ── 作品概览 AI 生成（真实链路，无 mock 降级） ────────────────────────────
// 端点 POST /ai/story-overview（Go 代理 → ai-service /api/ai/story-overview）：
//   req:  概览全部字段（title/description/logline/style/audience/intent）+ fields 子集
//   resp: { overview: Record<field, string>, usage, model }
// 链路要求：
//   1. 真实 LLM 生成——失败直接抛错由 UI toast，禁止任何预设选项冒充生成结果；
//   2. 单字段生成也必须携带概览全部字段作为上下文（服务端据此保证一致性）；
//   3. 服务端注入随机变体 + temperature 0.9，提示词硬性要求「热门度 + 创新性」。

export interface StoryOverviewContext {
  title: string;
  description: string;
  logline: string;
  style: string;
  audience: string;
  intent: string;
}

export type StoryOverviewField = keyof StoryOverviewContext;

/** 线索库种类：架构 / 大纲 / 记忆 / 伏笔（AIGC 卡勾选后对本模块所有 AIGC 生效） */
export type StoryOverviewClueKind = 'architecture' | 'outline' | 'memory' | 'foreshadow';

export interface StoryOverviewClue {
  kind: StoryOverviewClueKind;
  content: string;
}

export async function generateStoryOverview(
  ctx: StoryOverviewContext,
  fields: StoryOverviewField[],
  clues: StoryOverviewClue[] = [],
): Promise<Partial<Record<StoryOverviewField, string>>> {
  const data = (await apiClient.post('/ai/story-overview', {
    ...ctx,
    fields,
    ...(clues.length ? { clues } : {}),
  })) as unknown as {
    overview?: Partial<Record<StoryOverviewField, string>>;
  };
  const overview = data?.overview;
  const out: Partial<Record<StoryOverviewField, string>> = {};
  if (overview && typeof overview === 'object') {
    for (const f of fields) {
      const v = overview[f];
      if (typeof v === 'string' && v.trim()) out[f] = v.trim();
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error('AI 未返回有效内容');
  }
  return out;
}

