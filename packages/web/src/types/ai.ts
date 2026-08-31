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
