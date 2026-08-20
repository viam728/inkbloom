import apiClient from './api-client';

/** 图片归属域：与三种创作模式一一对应 */
export type ImageScope = 'novel' | 'media' | 'memo';

/** 上传响应（POST /images） */
export interface UploadedImage {
  id: number;
  url: string;
  thumb_url: string;
  content_hash: string;
  display_name: string;
  width: number;
  height: number;
  size: number;
  scope: ImageScope;
  source: string;
  /** 命中内容去重（秒传） */
  deduplicated: boolean;
}

/** 图床条目（GET /images items） */
export interface GalleryImage {
  id: number;
  url: string;
  thumb_url: string;
  content_hash: string;
  display_name: string;
  width: number;
  height: number;
  file_size: number;
  scope: ImageScope;
  source: string;
  novel_id: number | null;
  created_at: string;
}

export interface ListImagesResult {
  items: GalleryImage[];
  next_cursor: string | null;
}

export interface BatchDeleteResult {
  deleted: number;
  skipped: number[];
}

/** 上传图片（FormData: file + scope + novel_id?） */
export async function uploadImage(
  file: File,
  opts: { scope: ImageScope; novelId?: number },
): Promise<UploadedImage> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('scope', opts.scope);
  if (opts.novelId != null) fd.append('novel_id', String(opts.novelId));
  return (await apiClient.post('/images', fd)) as unknown as UploadedImage;
}

/** 分页列出图床（游标分页） */
export async function listImages(params: {
  scope?: ImageScope;
  novelId?: number;
  limit?: number;
  cursor?: string;
}): Promise<ListImagesResult> {
  return (await apiClient.get('/images', {
    params: {
      scope: params.scope,
      novel_id: params.novelId,
      limit: params.limit,
      cursor: params.cursor,
    },
  })) as unknown as ListImagesResult;
}

/** 删除单张图片；force=true 时强制删除被引用图片（409 = 被引用） */
export async function deleteImage(id: number, force = false): Promise<void> {
  await apiClient.delete(`/images/${id}`, { params: force ? { force: true } : undefined });
}

/** 批量删除（skipped 为被引用而跳过的 id） */
export async function batchDeleteImages(ids: number[]): Promise<BatchDeleteResult> {
  return (await apiClient.post('/images/batch-delete', { ids })) as unknown as BatchDeleteResult;
}
