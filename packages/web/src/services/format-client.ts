import apiClient from './api-client';
import type { FormatConvertResponse } from '@/types/format';

/**
 * 调用后端格式转换 API
 */
export async function convertFormat(contentJson: unknown, format: string): Promise<string> {
  const data = await apiClient.post('/format/convert', {
    content_json: contentJson,
    format,
  }) as unknown as FormatConvertResponse;
  return data.content;
}

/**
 * 导出章节为文件（返回 Blob）
 */
export async function exportChapter(chapterId: number, format: string): Promise<Blob> {
  const response = await apiClient.post(
    `/export/chapter/${chapterId}`,
    { format },
    { responseType: 'blob', transformResponse: [(d: string) => d] } as any,
  );
  // axios interceptor 已经提取 data，但 blob 响应需要特殊处理
  if (response instanceof Blob) return response;
  return new Blob([response as any]);
}

/**
 * 导出整本小说为 ZIP 文件（返回 Blob）
 */
export async function exportNovel(novelId: number, format: string): Promise<Blob> {
  const response = await apiClient.post(
    `/export/novel/${novelId}`,
    { format },
    { responseType: 'blob', transformResponse: [(d: string) => d] } as any,
  );
  if (response instanceof Blob) return response;
  return new Blob([response as any]);
}
