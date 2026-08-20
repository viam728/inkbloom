import { create } from 'zustand';
import { streamChat, streamInline, streamRewrite } from '@/services/sse-client';
import type { AIMessage, ChatMessage, RewriteAction } from '@/types';

interface RewriteResult {
  original: string;
  modified: string;
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

let abortController: AbortController | null = null;

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
    const { messages, currentModel } = get();

    const userMsg: AIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    const updatedMessages = [...messages, userMsg];
    set({ messages: updatedMessages, isStreaming: true, streamingContent: '' });

    const apiMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是 InkBloom 的 AI 写作助手。你帮助用户进行小说创作、情节设计、角色塑造等。请用中文回答。',
      },
      ...updatedMessages.map((m) => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
    ];

    abortController = new AbortController();

    let accumulated = '';

    try {
      await streamChat(
        apiMessages,
        (chunk) => {
          accumulated += chunk;
          set({ streamingContent: accumulated });
        },
        () => {
          const assistantMsg: AIMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: accumulated,
            timestamp: new Date(),
          };
          set((s) => ({
            messages: [...s.messages, assistantMsg],
            isStreaming: false,
            streamingContent: '',
          }));
          abortController = null;
        },
        { model: currentModel },
      );
    } catch {
      if (accumulated) {
        const assistantMsg: AIMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: accumulated,
          timestamp: new Date(),
        };
        set((s) => ({
          messages: [...s.messages, assistantMsg],
        }));
      }
      set({ isStreaming: false, streamingContent: '' });
      abortController = null;
    }
  },

  clearMessages: () => {
    set({ messages: [], streamingContent: '', isStreaming: false });
  },

  setModel: (model: string) => {
    set({ currentModel: model });
  },

  stopStreaming: () => {
    abortController?.abort();
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
          set({ rewriteResult: { original: selectedText, modified: accumulated } });
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
