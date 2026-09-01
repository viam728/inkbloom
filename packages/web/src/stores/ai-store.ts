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

interface AIStore {
  messages: AIMessage[];
  isStreaming: boolean;
  streamingContent: string;
  currentModel: string;

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
  stopStreaming: () => void;

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

export const useAIStore = create<AIStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  streamingContent: '',
  currentModel: 'deepseek-v4-flash',

  inlineSuggestion: null,
  isInlineStreaming: false,

  rewriteResult: null,
  showDiffViewer: false,
  isRewriteStreaming: false,

    sendMessage: async (content: string, attachments?: ChatAttachment[]) => {
    const { messages } = get();

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

    try {
      // 走对话式创作 Agent：一次完整 Agent 循环，Agent 自主决定调用工具
      // （create_novel / create_chapter / write_chapter / list_novels）。
      // 传入当前选中作品，起稿类工具默认作用于该作品（问题2）。
      const currentNovelId = useNovelStore.getState().currentNovel?.id ?? 0;
      const result = await agentChat(history, currentNovelId);

      const toolExecutions = (result.tool_executions ?? []).map((t) => ({
        tool: t.tool,
        label: toolLabel(t.tool),
      }));

      const assistantMsg: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.content || '（Agent 未返回内容）',
        timestamp: new Date(),
        toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
      };
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        isStreaming: false,
        streamingContent: '',
      }));

      // Agent 执行了工具（创建了小说/章节等）→ 通知创作系统刷新。
      if (toolExecutions.length > 0) {
        window.dispatchEvent(new CustomEvent('inkbloom:agent-executed'));
      }
    } catch (e) {
      console.error('agent chat failed', e);
      const assistantMsg: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '抱歉，Agent 执行出错，请重试。',
        timestamp: new Date(),
      };
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        isStreaming: false,
        streamingContent: '',
      }));
    }
  },

  clearMessages: () => {
    set({ messages: [], streamingContent: '', isStreaming: false });
  },

  setModel: (model: string) => {
    set({ currentModel: model });
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

/** 工具名 → 中文标签（展示 Agent 做了什么） */
function toolLabel(tool: string): string {
  switch (tool) {
    case 'create_novel':
      return '创建作品';
    case 'create_chapter':
      return '新建章节';
    case 'write_chapter':
      return '撰写正文';
    case 'list_novels':
      return '查看作品列表';
    default:
      return tool;
  }
}
