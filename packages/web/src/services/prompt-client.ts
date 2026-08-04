import apiClient from './api-client';
import type { ChatMessage } from '@/types';

export interface ImagePromptResult {
  prompt: string;
  negative_prompt: string;
}

export interface PromptBuildContext {
  novel_genre?: string;
  chapter_summary?: string;
  related_characters?: Array<{ name: string; description?: string; role?: string; appearance?: string }>;
  related_settings?: Array<{ name: string; description?: string; category?: string }>;
  recent_text?: string;
  text_to_polish?: string;
}

/**
 * Generate an English image prompt from Chinese novel context.
 */
export async function generateImagePrompt(
  contextText: string,
  genre?: string,
  style?: string,
): Promise<ImagePromptResult> {
  const data = (await apiClient.post('/aigc/prompt', {
    context_text: contextText,
    novel_genre: genre ?? '',
    style: style ?? 'realistic',
  })) as unknown as ImagePromptResult;
  return data;
}

/**
 * Generate image prompt using novel_id + chapter_id (Go fetches context automatically).
 */
export async function generateImagePromptFromChapter(
  novelId: number,
  chapterId: number,
  style?: string,
): Promise<ImagePromptResult> {
  const data = (await apiClient.post('/aigc/prompt', {
    novel_id: novelId,
    chapter_id: chapterId,
    style: style ?? 'realistic',
  })) as unknown as ImagePromptResult;
  return data;
}

/**
 * Build context-aware chat messages using the Python prompt service.
 */
export async function buildContextPrompt(
  context: PromptBuildContext,
  type: string = 'chat',
): Promise<ChatMessage[]> {
  const data = (await apiClient.post('/prompt/build', { context, type })) as unknown as { messages: ChatMessage[] };
  return data?.messages ?? [];
}
