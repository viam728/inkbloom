export interface AIGCTask {
  id: string;
  type: string;
  status: string;
  progress: number;
  prompt: string;
  provider: string;
}

export interface Asset {
  id: number;
  novel_id: number;
  chapter_id?: number;
  task_id: string;
  file_path: string;
  thumbnail_path: string;
  prompt: string;
  provider: string;
  width: number;
  height: number;
  file_size: number;
  confirmed: boolean;
  created_at: string;
}

/** AIGC 生成记录（GET /aigc/records items）：只含 AIGC，不含 upload */
export interface AigcRecord {
  id: number;
  prompt: string;
  provider: string;
  scope: string;
  asset_id: number | null;
  novel_id: number | null;
  created_at: string;
  url: string;
  thumb_url: string;
  display_name: string;
  content_hash: string;
}

export interface GenerateOptions {
  width?: number;
  height?: number;
  provider?: string;
  novel_id?: number;
  chapter_id?: number;
}

export interface ImageGenResponse {
  task_id: string;
  type: string;
  status: string;
  progress: number;
}
