import apiClient from './api-client';

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

/** 发送一条消息给创作 Agent，返回最终回复 + 执行过的工具列表。 */
export async function agentChat(
  messages: { role: string; content: string }[],
  novelId?: number,
): Promise<AgentChatResult> {
  const data = (await apiClient.post('/agent/chat', {
    messages,
    novel_id: novelId ?? 0,
  })) as unknown as AgentChatResult;
  return data;
}
