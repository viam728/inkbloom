export interface Novel {
  id: number;
  title: string;
  genre?: string;
  description?: string;
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
