/** 自媒体发布平台 */
export type MediaPlatform = 'wechat' | 'xiaohongshu' | 'weibo' | 'video';

export interface PlatformMeta {
  id: MediaPlatform;
  label: string;
  /** 正文字数建议上限 */
  maxWords: number;
  /** 平台风格提示（用于 AI 改写 prompt） */
  tone: string;
  emoji: string;
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'wechat', label: '公众号', maxWords: 3000, tone: '深度长文、观点清晰、段落分明', emoji: '💬' },
  { id: 'xiaohongshu', label: '小红书', maxWords: 1000, tone: '活泼种草、emoji 点缀、分段短句、带话题标签', emoji: '🌸' },
  { id: 'weibo', label: '微博', maxWords: 140, tone: '短平快、强观点、带话题词', emoji: '📣' },
  { id: 'video', label: '短视频脚本', maxWords: 600, tone: '口播节奏、开场钩子、分镜感', emoji: '🎬' },
];

/** 一篇自媒体内容（区别于小说章节，是独立的内容单元） */
export interface MediaContent {
  id: number;
  title: string;
  platform: MediaPlatform;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** 选题条目 */
export interface TopicItem {
  id: string;
  title: string;
  note: string;
  status: 'idea' | 'used' | 'dropped';
  created_at: string;
}
