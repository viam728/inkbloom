import { create } from 'zustand';
import { streamInline, streamRewrite } from '@/services/sse-client';
import { agentChat, buildUserContent } from '@/services/agent-chat-client';
import { useNovelStore } from '@/stores/novel-store';
import type { AIMessage, AgentCard, ChatAttachment, RewriteAction } from '@/types';

interface RewriteResult {
  original: string;
  modified: string;
  /** 触发本次改写的动作，用于采纳率分析（业务方案 v3 附录 B） */
  action?: RewriteAction;
}

/** 对话会话（历史管理，localStorage 持久化） */
export interface AISession {
  id: string;
  title: string;
  updatedAt: number;
}

const LS_SESSIONS = 'inkbloom:ai:sessions';
const LS_MSG_PREFIX = 'inkbloom:ai:msg:';

// agentAbort 是当前进行中 Agent 请求的中止控制器：停止按钮据此取消网络请求。
let agentAbort: AbortController | null = null;

function loadSessions(): AISession[] {
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    return raw ? (JSON.parse(raw) as AISession[]) : [];
  } catch {
    return [];
  }
}
function saveSessions(sessions: AISession[]): void {
  try {
    localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions));
  } catch {
    /* 存储满/隐私模式忽略 */
  }
}
function loadMessages(sessionId: string): AIMessage[] {
  try {
    const raw = localStorage.getItem(LS_MSG_PREFIX + sessionId);
    const arr = raw ? (JSON.parse(raw) as AIMessage[]) : [];
    return arr.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}
function saveMessages(sessionId: string, messages: AIMessage[]): void {
  try {
    localStorage.setItem(LS_MSG_PREFIX + sessionId, JSON.stringify(messages));
  } catch {
    /* 忽略 */
  }
}

/** 启动时恢复最近一次会话（无会话则空）。 */
function initialSessionState(): {
  sessions: AISession[];
  currentSessionId: string | null;
  messages: AIMessage[];
} {
  const sessions = loadSessions();
  const current = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  return {
    sessions,
    currentSessionId: current?.id ?? null,
    messages: current ? loadMessages(current.id) : [],
  };
}

/** 持久化某会话：写消息 + 更新标题（取首条用户消息）/时间，返回新的 sessions 列表。 */
function touchSession(id: string, messages: AIMessage[], sessions: AISession[]): AISession[] {
  saveMessages(id, messages);
  const first = messages.find((m) => m.role === 'user');
  const next = sessions.map((s) =>
    s.id === id ? { ...s, title: truncate(first?.content ?? ''), updatedAt: Date.now() } : s,
  );
  saveSessions(next);
  return next;
}

function truncate(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > 18 ? t.slice(0, 18) + '…' : t;
}

interface AIStore {
  messages: AIMessage[];
  isStreaming: boolean;
  streamingContent: string;
  currentModel: string;
  /** 场景级模型覆盖：key 为 AIScene，未设置（或 ''）跟随 currentModel */
  sceneModels: Partial<Record<AIScene, string>>;

  // 会话历史（C8）
  sessions: AISession[];
  currentSessionId: string | null;

  // Inline completion state
  inlineSuggestion: string | null;
  isInlineStreaming: boolean;

  // Rewrite state
  rewriteResult: RewriteResult | null;
  showDiffViewer: boolean;
  isRewriteStreaming: boolean;

    sendMessage: (content: string, attachments?: ChatAttachment[]) => Promise<void>;
  clearMessages: () => void;
  setModel: (model: string) => void;
  /** 场景级模型配置：model 为空串表示清除覆盖（跟随全局选择） */
  setSceneModel: (scene: AIScene, model: string) => void;
  stopStreaming: () => void;
  /** 停止当前正在进行的 Agent 请求（C8 停止中断） */
  cancelMessage: () => void;
  /** 新建会话并切过去 */
  newSession: () => void;
  /** 切换到指定会话 */
  loadSession: (id: string) => void;
  /** 删除会话 */
  deleteSession: (id: string) => void;

  // Inline actions
  triggerInline: (params: {
    novelId: number;
    chapterId: number;
    cursorPosition: number;
    precedingText: string;
    followingText: string;
  }) => Promise<void>;
  clearInlineSuggestion: () => void;

  // Rewrite actions
  triggerRewrite: (params: {
    novelId: number;
    chapterId: number;
    selectedText: string;
    action: RewriteAction;
  }) => Promise<void>;
  acceptRewrite: () => void;
  rejectRewrite: () => void;

  // ── 消息卡片（P0-1）────────────────────────────────────────────────
  /** 在消息流末尾插入一条 assistant 侧卡片消息，返回消息 id（供后续原地更新） */
  pushCardMessage: (card: AgentCard) => string;
  /** Q6 原地替换/更新：按消息 id 定位，用 updater 产出新 card（类型按 kind 收窄在调用侧保证） */
  updateCardMessage: (messageId: string, updater: (card: AgentCard) => AgentCard) => void;
  /** Q5/P1-2 预留位：卡片操作成功后回发轻量上下文。P0 为 no-op，P1 改为 sendMessage(text) */
  notifyAgentContext: (text: string) => void;
}

function truncateErr(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

const initial = initialSessionState();

// ── 模型选择（持久化 + 场景配置） ───────────────────────────────────────
/** AI 使用场景：每个场景可单独覆盖模型，未覆盖时跟随全局 currentModel */
export type AIScene = 'agent' | 'candidates' | 'inline' | 'rewrite' | 'expand';

export const AI_SCENE_LABELS: Record<AIScene, string> = {
  agent: '主聊天 / 创作 Agent',
  candidates: '候选起稿（N 选 1）',
  inline: '编辑器续写',
  rewrite: '改写润色',
  expand: '大纲扩写成稿',
};

/** 开发阶段统一默认模型 */
export const DEFAULT_AI_MODEL = 'glm-4.5-air';

const LS_MODEL = 'inkbloom-ai-model';
const LS_SCENE_MODELS = 'inkbloom-ai-scene-models';

function loadPersistedModel(): string {
  try {
    const v = localStorage.getItem(LS_MODEL);
    if (v) return v;
  } catch { /* ignore */ }
  return DEFAULT_AI_MODEL;
}

function loadPersistedSceneModels(): Partial<Record<AIScene, string>> {
  try {
    const raw = localStorage.getItem(LS_SCENE_MODELS);
    if (raw) return JSON.parse(raw) as Partial<Record<AIScene, string>>;
  } catch { /* ignore */ }
  return {};
}

/** 场景 → 实际调用模型：场景覆盖优先，未覆盖跟随全局选择 */
export function resolveSceneModel(scene: AIScene): string {
  const s = useAIStore.getState();
  return s.sceneModels[scene] || s.currentModel;
}

export const useAIStore = create<AIStore>((set, get) => ({
  messages: initial.messages,
  sessions: initial.sessions,
  currentSessionId: initial.currentSessionId,
  isStreaming: false,
  streamingContent: '',
  currentModel: loadPersistedModel(),
  sceneModels: loadPersistedSceneModels(),

  inlineSuggestion: null,
  isInlineStreaming: false,

  rewriteResult: null,
  showDiffViewer: false,
  isRewriteStreaming: false,

    sendMessage: async (content: string, attachments?: ChatAttachment[]) => {
    const { messages, sessions, currentSessionId } = get();

    // 无会话时自动建一个（首条消息即成为会话标题）。
    let sid = currentSessionId;
    let sess = sessions;
    if (!sid) {
      sid = crypto.randomUUID();
      sess = [{ id: sid, title: '新对话', updatedAt: Date.now() }, ...sessions];
      set({ currentSessionId: sid, sessions: sess });
    }

    const userMsg: AIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };

    const updatedMessages = [...messages, userMsg];
    set({ messages: updatedMessages, isStreaming: true, streamingContent: '' });

    // 历史只保留 user/assistant（工具消息由后端 Agent 循环内部管理）。
    // 带附件的 user 消息转成 OpenAI 多模态 content（图片 vision + 文档文本）。
    const history = updatedMessages.map((m) => ({
      role: m.role,
      content: buildUserContent(m.content, m.attachments),
    }));

    // C8 停止中断：AbortController 使「停止」按钮可取消进行中的请求。
    const controller = new AbortController();
    agentAbort = controller;

    try {
      const currentNovelId = useNovelStore.getState().currentNovel?.id ?? 0;
      // 模型选择一路透传：场景配置 → 前端 → Go Agent → ai-service → 上游。
      const result = await agentChat(history, currentNovelId, controller.signal, resolveSceneModel('agent'));

      const toolExecutions = (result.tool_executions ?? []).map((t) => ({
        tool: t.tool,
        label: toolLabel(t.tool, t.result),
      }));

      const assistantMsg: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.content || '（Agent 未返回内容）',
        timestamp: new Date(),
        toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
      };
      const nextMessages = [...get().messages, assistantMsg];
      set((s) => ({
        messages: nextMessages,
        isStreaming: false,
        streamingContent: '',
        sessions: touchSession(sid, nextMessages, s.sessions),
      }));

      // Agent 执行了工具（创建了小说/章节等）→ 通知创作系统刷新。
      if (toolExecutions.length > 0) {
        window.dispatchEvent(new CustomEvent('inkbloom:agent-executed'));
      }
    } catch (e) {
      // 被用户「停止」取消：不追加错误消息。
      if (controller.signal.aborted) {
        set({ isStreaming: false, streamingContent: '' });
        return;
      }
      console.error('agent chat failed', e);
      // 透出后端具体错误（apiClient 解包 APIResponse.message），便于定位。
      const detail =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '';
      const assistantMsg: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: detail
          ? `Agent 执行出错：${truncateErr(detail)}`
          : '抱歉，Agent 执行出错，请重试。',
        timestamp: new Date(),
      };
      const nextMessages = [...get().messages, assistantMsg];
      set((s) => ({
        messages: nextMessages,
        isStreaming: false,
        streamingContent: '',
        sessions: touchSession(sid, nextMessages, s.sessions),
      }));
    } finally {
      if (agentAbort === controller) agentAbort = null;
    }
  },

  clearMessages: () => {
    const { currentSessionId, sessions } = get();
    if (currentSessionId) {
      touchSession(currentSessionId, [], sessions);
    }
    set({ messages: [], streamingContent: '', isStreaming: false });
  },

  cancelMessage: () => {
    agentAbort?.abort();
    agentAbort = null;
    set({ isStreaming: false, streamingContent: '' });
  },

  newSession: () => {
    const id = crypto.randomUUID();
    const sessions = [{ id, title: '新对话', updatedAt: Date.now() }, ...get().sessions];
    saveSessions(sessions);
    set({ sessions, currentSessionId: id, messages: [], streamingContent: '', isStreaming: false });
  },

  loadSession: (id: string) => {
    set({ currentSessionId: id, messages: loadMessages(id), streamingContent: '', isStreaming: false });
  },

  deleteSession: (id: string) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    saveSessions(sessions);
    try {
      localStorage.removeItem(LS_MSG_PREFIX + id);
    } catch {
      /* 忽略 */
    }
    if (get().currentSessionId === id) {
      const next = sessions[0];
      set({
        sessions,
        currentSessionId: next?.id ?? null,
        messages: next ? loadMessages(next.id) : [],
      });
    } else {
      set({ sessions });
    }
  },

  setModel: (model: string) => {
    try { localStorage.setItem(LS_MODEL, model); } catch { /* ignore */ }
    set({ currentModel: model });
  },

  setSceneModel: (scene: AIScene, model: string) => {
    const next = { ...get().sceneModels };
    if (model) next[scene] = model;
    else delete next[scene];
    try { localStorage.setItem(LS_SCENE_MODELS, JSON.stringify(next)); } catch { /* ignore */ }
    set({ sceneModels: next });
  },

  stopStreaming: () => {
    set({ isStreaming: false, isInlineStreaming: false, isRewriteStreaming: false });
  },

  // ── Inline completion ─────────────────────────────────────────────────
  triggerInline: async ({ novelId, chapterId, cursorPosition, precedingText, followingText }) => {
    set({ isInlineStreaming: true, inlineSuggestion: null });

    let accumulated = '';

    try {
      await streamInline(
        novelId,
        chapterId,
        cursorPosition,
        precedingText,
        followingText,
        (chunk) => {
          accumulated += chunk;
          set({ inlineSuggestion: accumulated });
        },
        () => {
          set({ isInlineStreaming: false });
        },
        resolveSceneModel('inline'),
      );
    } catch {
      set({ isInlineStreaming: false });
    }
  },

  clearInlineSuggestion: () => {
    set({ inlineSuggestion: null });
  },

  // ── Rewrite ───────────────────────────────────────────────────────────
  triggerRewrite: async ({ novelId, chapterId, selectedText, action }) => {
    set({ isRewriteStreaming: true, rewriteResult: null, showDiffViewer: false });

    let accumulated = '';

    try {
      await streamRewrite(
        novelId,
        chapterId,
        selectedText,
        action,
        (chunk) => {
          accumulated += chunk;
          set({ rewriteResult: { original: selectedText, modified: accumulated, action } });
        },
        () => {
          set({ isRewriteStreaming: false, showDiffViewer: true });
        },
      );
    } catch {
      set({ isRewriteStreaming: false });
    }
  },

  acceptRewrite: () => {
    set({ rewriteResult: null, showDiffViewer: false });
  },

  rejectRewrite: () => {
    set({ rewriteResult: null, showDiffViewer: false });
  },

  // ── 消息卡片（P0-1）──────────────────────────────────────────────────
  pushCardMessage: (card: AgentCard) => {
    const id = crypto.randomUUID();
    const msg: AIMessage = {
      id,
      role: 'assistant',
      content: cardLeadText(card),
      timestamp: new Date(),
      card,
    };
    set((s) => ({ messages: [...s.messages, msg] }));
    return id;
  },

  updateCardMessage: (messageId: string, updater: (card: AgentCard) => AgentCard) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId && m.card ? { ...m, card: updater(m.card) } : m,
      ),
    }));
  },

  notifyAgentContext: (_text: string) => {
    // P0 no-op：卡片操作不回发对话上下文。P1-2 接入时改为 sendMessage(text)，
    // 所有卡片操作点已统一调用本方法，届时只需改这一处。
    return;
  },
}));

/** 卡片消息的引导文案（渲染在卡片上方） */
function cardLeadText(card: AgentCard): string {
  switch (card.kind) {
    case 'draft_config':
      return '已为你打开「AI 起稿」配置卡片，填写作品名与一句话创意后点击「开始起稿」。';
    case 'draft_result':
      return card.status === 'running' ? '起稿任务已提交，正在生成…' : '起稿任务进展如下：';
    default:
      return '';
  }
}

/** 工具名 → 中文标签（展示 Agent 做了什么）。write_chapter 附带字数变化摘要。 */
function toolLabel(tool: string, result?: Record<string, unknown>): string {
  switch (tool) {
    case 'create_novel':
      return '创建作品';
    case 'create_chapter':
      return '新建章节';
    case 'write_chapter': {
      const before = result?.before_chars;
      const after = result?.after_chars;
      if (typeof before === 'number' && typeof after === 'number') {
        return `撰写正文 · ${before}→${after} 字`;
      }
      return '撰写正文';
    }
    case 'list_novels':
      return '查看作品列表';
    default:
      return tool;
  }
}
