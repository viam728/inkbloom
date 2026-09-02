export interface Novel {
  id: number;
  title: string;
  genre?: string;
  description?: string;
  /** 概览元信息：文风 / 目标受众 / 创作意图（随概览统一管理） */
  style?: string;
  audience?: string;
  intent?: string;
  status?: string;
  word_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: number;
  novel_id: number;
  volume_id?: number;
  title: string;
  content?: string;
  content_json?: string;
  word_count?: number;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export interface Volume {
  id: number;
  novel_id: number;
  title: string;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}
