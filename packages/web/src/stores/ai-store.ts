import { create } from 'zustand';
import { streamInline, streamRewrite } from '@/services/sse-client';
import { agentChat } from '@/services/agent-chat-client';
import type { AIMessage, RewriteAction } from '@/types';

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

  sendMessage: (content: string) => Promise<void>;
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

  sendMessage: async (content: string) => {
    const { messages } = get();

    const userMsg: AIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    const updatedMessages = [...messages, userMsg];
    set({ messages: updatedMessages, isStreaming: true, streamingContent: '' });

    // 历史只保留 user/assistant 纯文本（工具消息由后端 Agent 循环内部管理）。
    const history = updatedMessages.map((m) => ({ role: m.role, content: m.content }));

    try {
      // 走对话式创作 Agent：一次完整 Agent 循环，Agent 自主决定调用工具
      // （create_novel / create_chapter / write_chapter / list_novels）。
      const result = await agentChat(history);

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
}));

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
