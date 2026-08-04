import apiClient from './api-client';
import type { MediaContent, MediaPlatform, TopicItem } from '@/types/media';
import { PLATFORMS } from '@/types/media';

/**
 * ═══ 自媒体创作服务层（后端预留对接） ═════════════════════════════════════
 *
 * 预留端点契约（待 server/ai-service 实现）：
 *
 * 1. GET    /media/contents                → { contents: MediaContent[] }
 *    POST   /media/contents                req: { title, platform, content, tags }
 *    PUT    /media/contents/:id            req: Partial<MediaContent>
 *    DELETE /media/contents/:id
 *    PUT    /media/contents/order          req: { ordered_ids: number[] }
 *
 * 2. GET    /media/topics                  → { topics: TopicItem[] }
 *    POST   /media/topics                  req: { title, note }
 *    DELETE /media/topics/:id
 *
 * 3. POST   /ai/generate-titles
 *    req:  { topic: string; platform: MediaPlatform; count?: number }
 *    resp: { titles: string[] }
 *
 * 4. POST   /ai/adapt-content
 *    req:  { content: string; platform: MediaPlatform }
 *    resp: { adapted: string }
 *
 * 后端未就绪时：内容/选题降级 localStorage，AI 能力降级为本地模板生成。
 * ══════════════════════════════════════════════════════════════════════
 */

const DEV_MOCK = import.meta.env.DEV;
const CONTENT_KEY = 'inkbloom-media-contents';
const TOPIC_KEY = 'inkbloom-media-topics';
const now = () => new Date().toISOString();

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// ── 内容 CRUD ───────────────────────────────────────────────────────────
export async function fetchMediaContents(): Promise<MediaContent[]> {
  try {
    const data = (await apiClient.get('/media/contents')) as unknown as {
      contents?: MediaContent[];
    };
    return data?.contents ?? (Array.isArray(data) ? (data as unknown as MediaContent[]) : []);
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return read<MediaContent[]>(CONTENT_KEY, []);
  }
}

export async function createMediaContent(data: {
  title: string;
  platform: MediaPlatform;
}): Promise<MediaContent> {
  const payload = { ...data, content: '', tags: [] as string[] };
  try {
    return (await apiClient.post('/media/contents', payload)) as unknown as MediaContent;
  } catch (e) {
    if (!DEV_MOCK) throw e;
    const item: MediaContent = {
      id: Date.now(),
      title: data.title,
      platform: data.platform,
      content: '',
      tags: [],
      created_at: now(),
      updated_at: now(),
    };
    write(CONTENT_KEY, [item, ...read<MediaContent[]>(CONTENT_KEY, [])]);
    return item;
  }
}

export async function updateMediaContent(id: number, patch: Partial<MediaContent>): Promise<void> {
  try {
    await apiClient.put(`/media/contents/${id}`, patch);
  } catch (e) {
    if (!DEV_MOCK) throw e;
    const list = read<MediaContent[]>(CONTENT_KEY, []);
    write(
      CONTENT_KEY,
      list.map((c) => (c.id === id ? { ...c, ...patch, updated_at: now() } : c)),
    );
  }
}

export async function deleteMediaContent(id: number): Promise<void> {
  try {
    await apiClient.delete(`/media/contents/${id}`);
  } catch (e) {
    if (!DEV_MOCK) throw e;
    write(CONTENT_KEY, read<MediaContent[]>(CONTENT_KEY, []).filter((c) => c.id !== id));
  }
}

/** 按传入 id 顺序持久化内容排序（拖拽排序，后端预留） */
export async function reorderMediaContents(orderedIds: number[]): Promise<void> {
  try {
    await apiClient.put('/media/contents/order', { ordered_ids: orderedIds });
  } catch {
    /* 后端不可用，降级本地持久化 */
    const list = read<MediaContent[]>(CONTENT_KEY, []);
    const byId = new Map(list.map((c) => [c.id, c]));
    const next: MediaContent[] = [];
    orderedIds.forEach((id) => {
      const c = byId.get(id);
      if (c) {
        next.push(c);
        byId.delete(id);
      }
    });
    byId.forEach((c) => next.push(c));
    write(CONTENT_KEY, next);
  }
}

// ── 选题池 CRUD ─────────────────────────────────────────────────────────
export async function fetchTopics(): Promise<TopicItem[]> {
  try {
    const data = (await apiClient.get('/media/topics')) as unknown as { topics?: TopicItem[] };
    return data?.topics ?? (Array.isArray(data) ? (data as unknown as TopicItem[]) : []);
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return read<TopicItem[]>(TOPIC_KEY, []);
  }
}

export async function saveTopics(topics: TopicItem[]): Promise<void> {
  try {
    await apiClient.post('/media/topics', { topics });
  } catch {
    /* 后端不可用，仅本地保存 */
  }
  write(TOPIC_KEY, topics);
}

// ── AI 标题生成 ─────────────────────────────────────────────────────────
export async function generateTitles(topic: string, platform: MediaPlatform, count = 8): Promise<string[]> {
  try {
    const data = (await apiClient.post('/ai/generate-titles', {
      topic,
      platform,
      count,
    })) as unknown as { titles?: string[] };
    if (data?.titles?.length) return data.titles;
    throw new Error('empty titles');
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return mockTitles(topic, platform, count);
  }
}

const TITLE_PATTERNS: Record<MediaPlatform, ((t: string) => string)[]> = {
  wechat: [
    (t) => `关于${t}，这是我听过最清醒的答案`,
    (t) => `${t}的底层逻辑，90% 的人都想错了`,
    (t) => `我研究了 100 个案例，终于看懂了${t}`,
    (t) => `${t}：真正拉开差距的，是这三件事`,
    (t) => `写给在${t}里迷茫的你`,
  ],
  xiaohongshu: [
    (t) => `🔥${t}保姆级攻略！亲测有效`,
    (t) => `谁懂啊！${t}真的可以这么简单😭`,
    (t) => `${t}避坑指南｜少走3年弯路✨`,
    (t) => `码住！${t}的 5 个宝藏技巧 🌟`,
    (t) => `被问爆的${t}秘籍，今天全公开`,
  ],
  weibo: [
    (t) => `#话题#${t}到底值不值得投入？说点大实话`,
    (t) => `${t}这件事，越早明白越好。`,
    (t) => `关于${t}，一句话总结：方向比努力重要。`,
  ],
  video: [
    (t) => `《30秒讲清楚：${t}》口播脚本`,
    (t) => `《${t}的真相》｜开头 3 秒抓住观众`,
    (t) => `《关于${t}的 3 个误区》分镜脚本`,
  ],
};

function mockTitles(topic: string, platform: MediaPlatform, count: number): Promise<string[]> {
  const patterns = TITLE_PATTERNS[platform] ?? TITLE_PATTERNS.wechat;
  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    titles.push(patterns[i % patterns.length](topic || '这个选题'));
  }
  return Promise.resolve(titles);
}

// ── AI 平台改写 ─────────────────────────────────────────────────────────
export async function adaptContent(content: string, platform: MediaPlatform): Promise<string> {
  try {
    const data = (await apiClient.post('/ai/adapt-content', {
      content,
      platform,
    })) as unknown as { adapted?: string };
    if (data?.adapted) return data.adapted;
    throw new Error('empty adapted');
  } catch (e) {
    if (!DEV_MOCK) throw e;
    return mockAdapt(content, platform);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mockAdapt(content: string, platform: MediaPlatform): Promise<string> {
  const plain = stripHtml(content);
  const meta = PLATFORMS.find((p) => p.id === platform);
  const label = meta?.label ?? platform;

  let body = plain;
  if (platform === 'weibo' && plain.length > 140) {
    body = plain.slice(0, 137) + '…';
  } else if (platform === 'xiaohongshu' && plain.length > 950) {
    body = plain.slice(0, 950) + '…';
  }

  const templates: Record<MediaPlatform, string> = {
    wechat: `${body}\n\n—— 关注我，下一篇聊聊更深层的原因。`,
    xiaohongshu: `✨ ${body}\n\n#经验分享 #干货整理 #创作者日常`,
    weibo: `【今日分享】${body} #创作者日记#`,
    video: `【开场钩子】你真的了解这件事吗？\n【正文】${body}\n【结尾】关注我，下期更精彩。`,
  };

  return Promise.resolve(
    `【${label}版本 · 模拟改写，后端就绪后由 AI 生成】\n\n${templates[platform]}`,
  );
}
