import type { StoryJobConfig, StoryStage, StoryStatus } from '@/services/story-client';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  /** 创作 Agent 执行过的工具（展示在消息下方） */
  toolExecutions?: { tool: string; label: string }[];
  /** 消息卡片（Q2：渲染在 assistant 消息侧；带 card 的消息 content 可为引导文案） */
  card?: AgentCard;
}

/** ── 消息卡片机制（P0-1）──────────────────────────────────────────
 * 判别联合：以 kind 区分卡片种类，后续 polish/outline 卡片加新分支即可。
 * 卡片状态与操作结果全部存在消息数组内（内存态，本期不持久化）。
 */
export type AgentCard = DraftConfigCard | DraftResultCard;

/** 起稿配置卡片（Q1：点 skill 即插入；Q6：确认后原地替换为 DraftResultCard） */
export interface DraftConfigCard {
  kind: 'draft_config';
  /** editing: 可编辑；submitted: 已提交（瞬间态，随即被替换为结果卡） */
  status: 'editing' | 'submitted';
  novelId: number;
  /** 作品名（createStoryJob.title） */
  title: string;
  /** 一句话创意（createStoryJob.logline） */
  logline: string;
  /** 生成设置，滑动条规格与旧面板一致：3–50 默认 10 / 500–5000 step100 默认 2000 */
  config: StoryJobConfig;
}

/** verify 阶段一致性报告摘要项（结果卡 issue 列表渲染用） */
export interface DraftIssueSummary {
  description?: string;
  entity?: string;
}

/** 起稿结果卡片（P0-4 / P0-6 状态机） */
export interface DraftResultCard {
  kind: 'draft_result';
  jobId: number;
  novelId: number;
  /** job 标题（回显 createStoryJob.title） */
  title: string;
  /** running: 提交中/生成中；ready: 有产物可看；
   *  adopted: 当前章节已采纳；abandoned: 已放弃（灰化终态）；
   *  failed: 失败占位态（重试 P1-3） */
  status: 'running' | 'ready' | 'adopted' | 'abandoned' | 'failed';
  /** 当前流水线阶段（badge 展示） */
  stage: StoryStage;
  /** 当前阶段产物正文（stage_payload.content；verify 阶段为空则只展示报告摘要） */
  content?: string;
  /** verify 阶段一致性报告摘要（issue 摘要列表 + 数量） */
  issues?: DraftIssueSummary[];
  issueCount?: number;
  /** 采纳成功后记录的章节 key（「已采纳 ✓」disabled 依据 + 幂等重试用） */
  adoptedKey?: string;
  /** job 状态快照（failed/paused 分支渲染用） */
  jobStatus?: StoryStatus;
  /** 已采纳章节数快照（采纳时生成「第 N 章」回退标题用） */
  chapterKeys?: number;
  /** 失败摘要 */
  error?: string;
}

export interface ChatChunkData {
  content: string;
  finish_reason?: string;
}

export interface ChatRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface InlineRequest {
  novel_id: number;
  chapter_id: number;
  cursor_position: number;
  preceding_text: string;
  following_text: string;
}

export interface RewriteRequest {
  novel_id: number;
  chapter_id: number;
  selected_text: string;
  action: 'polish' | 'expand' | 'condense' | 'humanize';
}

export type RewriteAction = 'polish' | 'expand' | 'condense' | 'humanize';
