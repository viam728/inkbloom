import apiClient from './api-client';

/**
 * 产品埋点（业务方案 v3 附录 B，施工任务 A40）
 *
 * 设计约束：
 *  - 只上报 ID、枚举与计数，**绝不携带正文、标题等用户创作内容**；
 *  - 队列 + 5s 批量 flush，beforeunload 用 sendBeacon 兜底；
 *  - 任何失败都静默：埋点绝不能影响主流程或打断用户。
 */

const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE = 100;
const STORAGE_ANON = 'inkbloom:anon-id';
const STORAGE_SESSION = 'inkbloom:session-id';

interface AnalyticsEvent {
  event: string;
  props?: Record<string, string | number | boolean>;
  ts?: string;
}

/** 生成一个不依赖 crypto 的随机 id（file:// 下 crypto.randomUUID 未必可用） */
function randomId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** 匿名 id：跨会话稳定，存 localStorage（未登录读者的唯一关联键） */
function getAnonymousId(): string {
  try {
    let id = localStorage.getItem(STORAGE_ANON);
    if (!id) {
      id = randomId('anon');
      localStorage.setItem(STORAGE_ANON, id);
    }
    return id;
  } catch {
    return 'anon-unavailable';
  }
}

/** 会话 id：每页会话一个，存 sessionStorage */
function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(STORAGE_SESSION);
    if (!id) {
      id = randomId('sess');
      sessionStorage.setItem(STORAGE_SESSION, id);
    }
    return id;
  } catch {
    return 'sess-unavailable';
  }
}

let queue: AnalyticsEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function flush(): Promise<void> {
  clearTimer();
  if (queue.length === 0) return;

  const batch = queue;
  queue = [];
  const payload = {
    events: batch,
    anonymous_id: getAnonymousId(),
    session_id: getSessionId(),
  };

  try {
    await apiClient.post('/events', payload);
  } catch {
    // 失败静默丢弃：埋点数据允许丢失，不允许重试风暴干扰业务请求
  }
}

function scheduleFlush() {
  if (timer !== null) return;
  timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

/**
 * 上报一个事件。
 *
 * @param event 小写下划线命名，如 'ai_generated'
 * @param props 仅标量值；对象/数组会被服务端丢弃，请在调用侧展开
 */
export function track(event: string, props?: Record<string, string | number | boolean>): void {
  if (queue.length >= MAX_QUEUE) return; // 队列积压时丢弃，防止内存膨胀
  queue.push({
    event,
    ...(props ? { props } : {}),
    ts: new Date().toISOString(),
  });
  scheduleFlush();
}

/** 页面离开前兜底：sendBeacon 在 unload 期间比 fetch 可靠 */
export function installAnalyticsFlushHooks(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeunload', () => {
    if (queue.length === 0) return;
    const payload = JSON.stringify({
      events: queue,
      anonymous_id: getAnonymousId(),
      session_id: getSessionId(),
    });
    // sendBeacon 不带自定义 header，因此无法复用 api-client 的 Bearer 注入；
    // /events 本身就是匿名端点，令牌缺失只影响 uid 归属，不影响数据入库。
    try {
      navigator.sendBeacon('/api/v1/events', new Blob([payload], { type: 'application/json' }));
      queue = [];
    } catch {
      // 忽略
    }
  });
  // 页面隐藏（切 tab / 移动端切后台）时也 flush 一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}

/** 供测试与调试使用：立即清空队列 */
export function flushAnalytics(): Promise<void> {
  return flush();
}
