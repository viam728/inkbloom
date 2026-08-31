import apiClient from './api-client';
import { generateImagePrompt } from './prompt-client';

/**
 * 场景化 Agent 生成 & 立绘上传 / AI 立绘生成客户端。
 *
 * 端点契约：
 *   POST /ai/agent/generate      req: AgentGenerateRequest → { content, scene, model, elapsed_ms }
 *   POST /novels/:id/portraits   multipart 字段 `file` → { url, thumb_url, width, height, size }
 *   POST /media/portraits        同上（自媒体全局立绘）
 *   AIGC 立绘：/aigc/prompt（复用 prompt-client）→ /aigc/generate 建任务 → 轮询 /tasks/:id 取 result
 */

export type AgentScene = 'character' | 'setting' | 'summary' | 'inspiration' | 'outline' | 'chapter';

export interface AgentGenerateRequest {
  novel_id: number;
  scene: AgentScene;
  item_id?: string;
  node_id?: string;
  instruction?: string;
}

export interface AgentGenerateResult {
  content: string;
  scene: string;
  model?: string;
  elapsed_ms?: number;
  error?: string;
}

/** 调用场景化 Agent 生成；data 含 error 时抛错（code≠200 由 axios 拦截器 reject） */
export async function agentGenerate(req: AgentGenerateRequest): Promise<AgentGenerateResult> {
  const data = (await apiClient.post('/ai/agent/generate', req)) as unknown as AgentGenerateResult;
  if (data?.error) throw new Error(data.error);
  if (!data?.content) throw new Error('Agent 未返回内容');
  return data;
}

/** 立绘上传响应（url 为 /assets/files/... 相对路径，Go 后端 StaticFS 直接可访问） */
export interface PortraitUploadResult {
  url: string;
  thumb_url: string;
  width: number;
  height: number;
  size: number;
}

/** 上传立绘：novel scope 走 /novels/:id/portraits，media scope 走 /media/portraits */
export async function uploadPortrait(scope: 'novel' | 'media', novelId: number | undefined, file: File): Promise<PortraitUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const path = scope === 'novel' ? `/novels/${novelId}/portraits` : '/media/portraits';
  const data = (await apiClient.post(path, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })) as unknown as PortraitUploadResult;
  return data;
}

/** AIGC 任务结果中的图片信息（result JSON：image_handler 透传 ai-service 返回） */
interface AIGCTaskResult {
  url?: string;
  file_path?: string;
  thumbnail_path?: string;
}

interface AIGCTaskStatus {
  task_id?: string;
  status?: string;
  progress?: number;
  error_msg?: string;
  result?: AIGCTaskResult | string | null;
}

/** 轮询上限与间隔：与 aigc-store 的 2s 节奏保持一致 */
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TIMES = 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * AI 生成立绘（复用既有 AIGC 链路）：
 * 1. /aigc/prompt：由中文描述生成英文图片 prompt；
 * 2. /aigc/generate：提交生成任务（幂等键冲突时返回既有任务）；
 * 3. 轮询 /tasks/:id 至 success，从 result 中取图片路径。
 * 失败（含 provider 未配置）向上抛错，由调用方 toast 友好提示。
 */
export async function generatePortraitImage(
  contextText: string,
  novelId: number,
): Promise<{ url: string; thumb_url: string }> {
  const promptResult = await generateImagePrompt(contextText);
  if (!promptResult?.prompt) throw new Error('Prompt 生成失败');

  const gen = (await apiClient.post('/aigc/generate', {
    prompt: promptResult.prompt,
    width: 768,
    height: 1152,
    provider: 'pollinations',
    novel_id: novelId > 0 ? novelId : undefined,
  })) as unknown as { task_id?: string };
  const taskId = gen?.task_id;
  if (!taskId) throw new Error('图片任务创建失败');

  for (let i = 0; i < POLL_MAX_TIMES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const status = (await apiClient.get(`/tasks/${taskId}`)) as unknown as AIGCTaskStatus;
    const state = status?.status ?? 'pending';
    if (state === 'success') {
      const result = typeof status.result === 'string' ? tryParse(status.result) : status.result;
      const url = result?.file_path || result?.url;
      if (!url) throw new Error('生成结果缺少图片地址');
      return { url, thumb_url: result?.thumbnail_path || url };
    }
    if (state === 'failed' || state === 'dead_letter') {
      throw new Error(status?.error_msg || '图片生成失败');
    }
  }
  throw new Error('图片生成超时');
}

function tryParse(raw: string): AIGCTaskResult | null {
  try {
    return JSON.parse(raw) as AIGCTaskResult;
  } catch {
    return null;
  }
}
