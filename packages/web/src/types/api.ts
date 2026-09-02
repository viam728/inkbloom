export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface CreateNovelRequest {
  title: string;
  genre?: string;
  description?: string;
  style?: string;
  audience?: string;
  intent?: string;
}

export interface UpdateNovelRequest {
  title?: string;
  genre?: string;
  description?: string;
  style?: string;
  audience?: string;
  intent?: string;
  status?: string;
}

export interface CreateChapterRequest {
  novel_id: number;
  title: string;
  content?: string;
  volume_id?: number;
}

export interface UpdateChapterRequest {
  title?: string;
  content?: string;
  content_json?: string;
}

export interface CreateVolumeRequest {
  novel_id: number;
  title: string;
}
