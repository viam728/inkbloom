import apiClient from './api-client';
import type { ChatAttachment } from '@/types';

/** 对话式创作 Agent：一次完整 Agent 循环（LLM 决定工具调用，Go 执行并回传）。 */

export interface AgentToolExecution {
  tool: string;
  args: string;
  result?: Record<string, unknown>;
}

export interface AgentChatResult {
  content: string;
  tool_executions: AgentToolExecution[];
}

/** OpenAI 多模态消息片段：文本或图片 */
export type AgentMultimodalPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** 发送给 Agent 的单条消息：纯文本或含图多模态 */
export interface AgentChatMessage {
    role: string;
    content: string | AgentMultimodalPart[];
}

/** 把一条用户消息（文本 + 附件）组装成 OpenAI 多模态 content */
export function buildUserContent(
    text: string,
    attachments?: ChatAttachment[],
): string | AgentMultimodalPart[] {
    if (!attachments || attachments.length === 0) return text;

    const parts: AgentMultimodalPart[] = [];
    if (text.trim()) parts.push({ type: 'text', text });

    for (const a of attachments) {
        if (a.kind === 'image' && a.dataUrl) {
            parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        } else if (a.kind === 'text' && a.text) {
            parts.push({
                type: 'text',
                text: `\n\n[附件「${a.name}」内容]\n${a.text}`,
            });
        }
    }
    // 兜底：附件存在但都无有效内容时退回纯文本
    return parts.length > 0 ? parts : text;
}

/** 发送一条消息给创作 Agent，返回最终回复 + 执行过的工具列表。 */
export async function agentChat(
    messages: AgentChatMessage[],
  novelId?: number,
): Promise<AgentChatResult> {
  const data = (await apiClient.post('/agent/chat', {
    messages,
    novel_id: novelId ?? 0,
  })) as unknown as AgentChatResult;
  return data;
}
