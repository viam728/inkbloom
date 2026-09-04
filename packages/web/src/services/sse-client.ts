import type { ChatMessage, ChatRequestOptions } from '@/types';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/components/common/Toast';

/** 动态构造鉴权头：每次请求时读取最新 access_token（续期后自动生效） */
function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 流式请求的可选项：signal 支持中断（F2-6），onError 独立错误通道 */
export interface StreamOptions {
  signal?: AbortSignal;
  /** 请求失败 / 流中断 / 服务端 error 帧时回调；不传时降级为 toast，绝不污染正文 */
  onError?: (message: string) => void;
}

/**
 * Common SSE stream reader: reads a fetch Response body and calls
 * onChunk for each content token, onDone when the stream finishes.
 *
 * F2-6：错误不再作为正文 chunk 下发（`[Error] …` 曾被直接插入作者正文）。
 * 失败走 onError 通道；服务端的 `event: error` 帧同样路由到 onError。
 */
async function readSSEStream(
  response: Response,
  onChunk: (content: string) => void,
  onDone: () => void,
  onError?: (message: string) => void,
): Promise<void> {
  const fail = (message: string) => {
    if (onError) onError(message);
    else toast.show(message, 'error');
  };

  if (!response.ok) {
    fail(`AI 请求失败（${response.status}），请稍后重试`);
    onDone();
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    fail('AI 服务无响应内容');
    onDone();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // SSE 事件名帧：`event: error` 等，作用于紧随其后的 data 行
        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7).trim();
          continue;
        }
        if (trimmed === '') {
          currentEvent = '';
          continue;
        }
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          onDone();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          // 服务端显式错误帧（与 F3-8 对齐）：独立通道，不进正文
          if (currentEvent === 'error') {
            fail(parsed.message || parsed.content || 'AI 生成出错，请重试');
            onDone();
            return;
          }
          if (parsed.error) {
            fail(parsed.error);
            onDone();
            return;
          }
          if (parsed.content) {
            onChunk(parsed.content);
          }
        } catch {
          // ignore malformed JSON chunks
        }
        currentEvent = '';
      }
    }
  } catch (e) {
    // 中断（AbortError）是用户主动行为，不打扰；其余读流失败走错误通道
    if ((e as Error)?.name !== 'AbortError') {
      fail('连接中断，请重试');
    }
  } finally {
    reader.releaseLock();
  }

  onDone();
}

/**
 * Stream a chat conversation via SSE through the Go backend.
 */
export async function streamChat(
  messages: ChatMessage[],
  onChunk: (content: string) => void,
  onDone: () => void,
  options?: ChatRequestOptions & StreamOptions,
): Promise<void> {
  const response = await fetch('/api/v1/ai/chat', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messages,
      model: options?.model,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
    }),
    signal: options?.signal,
  });

  await readSSEStream(response, onChunk, onDone, options?.onError);
}

/**
 * Stream inline completion via SSE through the Go backend.
 */
export async function streamInline(
  novelId: number,
  chapterId: number,
  cursorPosition: number,
  precedingText: string,
  followingText: string,
  onChunk: (content: string) => void,
  onDone: () => void,
  options?: StreamOptions & { model?: string },
): Promise<void> {
  const response = await fetch('/api/v1/ai/inline', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      novel_id: novelId,
      chapter_id: chapterId,
      cursor_position: cursorPosition,
      preceding_text: precedingText,
      following_text: followingText,
      model: options?.model || undefined,
    }),
    signal: options?.signal,
  });

  await readSSEStream(response, onChunk, onDone, options?.onError);
}

/**
 * Stream rewrite (polish/expand/condense/humanize) via SSE through the Go backend.
 */
export async function streamRewrite(
  novelId: number,
  chapterId: number,
  selectedText: string,
  action: string,
  onChunk: (content: string) => void,
  onDone: () => void,
  options?: StreamOptions & { model?: string },
): Promise<void> {
  const response = await fetch('/api/v1/ai/rewrite', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      novel_id: novelId,
      chapter_id: chapterId,
      selected_text: selectedText,
      action,
      model: options?.model || undefined,
    }),
    signal: options?.signal,
  });

  await readSSEStream(response, onChunk, onDone, options?.onError);
}
