/** 公开发布态类型（业务方案 v3 E4，与后端 JSON 标签一致，snake_case） */

export interface PublicWork {
  id: number;
  slug: string;
  title: string;
  synopsis: string;
  cover_url: string;
  ai_inspired: boolean;
  follow_count: number;
}

export interface PublicChapterSummary {
  id: number;
  title: string;
  word_count: number;
  position: number;
}

export interface PublicChapter extends PublicChapterSummary {
  work_id: number;
  /** HTML 片段，已服务端净化，可直接 dangerouslySetInnerHTML */
  content: string;
}

/** 作者侧的发布作品 */
export interface PublishedWork {
  id: number;
  novel_id: number;
  slug: string;
  title: string;
  synopsis: string;
  cover_url: string;
  visibility: 'public' | 'unlisted' | 'private';
  ai_inspired: boolean;
  ai_inspired_source?: 'chapter' | 'author' | '';
  follow_count: number;
  created_at: string;
  updated_at: string;
}

export interface PublishedChapter {
  id: number;
  work_id: number;
  chapter_id: number;
  version_id?: number;
  title: string;
  word_count: number;
  position: number;
  scheduled_at?: string;
  published_at: string;
}

export interface ReadingProgress {
  work_id: number;
  chapter_id: number;
  position: number;
}

/** 作者侧单章读者漏斗（plan A23） */
export interface ChapterStats {
  chapter_id: number;
  title: string;
  position: number;
  reader_count: number;
}

/** 作者侧作品阅读数据（plan A23） */
export interface WorkStats {
  work_id: number;
  follow_count: number;
  reader_count: number;
  chapters: ChapterStats[];
}
