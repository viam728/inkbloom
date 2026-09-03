import type { ChatMessage, ChatRequestOptions } from '@/types';
import { useAuthStore } from '@/stores/auth-store';

/** 动态构造鉴权头：每次请求时读取最新 access_token（续期后自动生效） */
function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Common SSE stream reader: reads a fetch Response body and calls
 * onChunk for each content token, onDone when the stream finishes.
 */
async function readSSEStream(
  response: Response,
  onChunk: (content: string) => void,
  onDone: () => void,
): Promise<void> {
  if (!response.ok) {
    onChunk(`[Error] Request failed (${response.status})`);
    onDone();
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    onChunk('[Error] No response body');
    onDone();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          onDone();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.content) {
            onChunk(parsed.content);
          }
        } catch {
          // ignore malformed JSON chunks
        }
      }
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
  options?: ChatRequestOptions,
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
  });

  await readSSEStream(response, onChunk, onDone);
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
  model?: string,
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
      model: model || undefined,
    }),
  });

  await readSSEStream(response, onChunk, onDone);
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
  model?: string,
): Promise<void> {
  const response = await fetch('/api/v1/ai/rewrite', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      novel_id: novelId,
      chapter_id: chapterId,
      selected_text: selectedText,
      action,
      model: model || undefined,
    }),
  });

  await readSSEStream(response, onChunk, onDone);
}
