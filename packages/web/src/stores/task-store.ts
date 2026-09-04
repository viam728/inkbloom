import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { wsClient } from '@/services/ws-client';

/**
 * 后台任务状态通知（备忘录 L61）：
 * 任务列表是一种状态通知——提示 + 中断。仅跟踪本会话创建的任务：
 * - 前端临时存储（内存），刷新页面即销毁，不回放历史任务；
 * - 任务到达终态（完成/失败/中止）后通知在后台自动销毁。
 */
export interface TaskItem {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'dead_letter' | 'cancelled';
  progress: number;
  error_msg: string;
  novel_id: number | null;
  chapter_id: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const isActive = (s: TaskItem['status']) => s === 'pending' || s === 'running';
const isTerminal = (s: TaskItem['status']) => !isActive(s);

/** 终态通知展示时长：让用户看到「已完成/已中止」再销毁 */
const TERMINAL_LINGER_MS = 2500;

interface TaskStore {
  tasks: TaskItem[];
  /** 任务创建后登记进会话通知列表（未知来源不接收） */
  register: (task: Pick<TaskItem, 'id' | 'type'> & Partial<TaskItem>) => void;
  /** 中止任务（POST /tasks/:id/cancel）；暂停语义对当前任务类型无意义，统一为中止 */
  cancel: (id: string) => Promise<void>;
  /** 监听 WS 任务事件（仅更新会话内已登记的任务）；幂等 */
  startWatch: () => void;
  /** 停止轮询与监听（登出/卸载时清理） */
  stopWatch: () => void;
}

let watching = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 终态销毁定时器（id → timer），重复终态/注销时防叠 */
const destroyTimers = new Map<string, ReturnType<typeof setTimeout>>();

const scheduleDestroy = (set: (fn: (s: TaskStore) => Partial<TaskStore>) => void, id: string) => {
  const prev = destroyTimers.get(id);
  if (prev) clearTimeout(prev);
  destroyTimers.set(
    id,
    setTimeout(() => {
      destroyTimers.delete(id);
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    }, TERMINAL_LINGER_MS),
  );
};

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],

  register: (task) => {
    set((s) => {
      if (s.tasks.some((t) => t.id === task.id)) return {};
      const item: TaskItem = {
        progress: 0,
        error_msg: '',
        novel_id: null,
        chapter_id: null,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        ...task,
      } as TaskItem;
      return { tasks: [item, ...s.tasks] };
    });
  },

  cancel: async (id) => {
    await apiClient.post(`/tasks/${id}/cancel`);
    // 乐观置为已中止并按终态销毁；后端 task:cancelled 事件幂等
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'cancelled' as const } : t)),
    }));
    scheduleDestroy(set, id);
  },

  startWatch: () => {
    if (watching) return;
    watching = true;
    /** WS/轮询共用的合并逻辑：只更新会话内已登记的任务（通知不回放历史） */
    const merge = (patch: { id: string } & Partial<TaskItem>) => {
      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === patch.id);
        if (idx < 0) return {};
        const tasks = s.tasks.map((t) => (t.id === patch.id ? { ...t, ...patch } : t));
        return { tasks };
      });
      const now = useTaskStore.getState().tasks.find((t) => t.id === patch.id);
      if (now && isTerminal(now.status)) scheduleDestroy(set, patch.id);
    };
    wsClient.on('task:progress', (data: any) => {
      if (data?.task_id) merge({ id: data.task_id, progress: data.progress ?? 0, status: 'running' });
    });
    wsClient.on('task:completed', (data: any) => {
      if (data?.task_id) merge({ id: data.task_id, status: 'success', progress: 100 });
    });
    wsClient.on('task:failed', (data: any) => {
      if (data?.task_id) merge({ id: data.task_id, status: 'failed', error_msg: data?.error ?? '' });
    });
    wsClient.on('task:dead_letter', (data: any) => {
      if (data?.task_id) merge({ id: data.task_id, status: 'dead_letter' });
    });
    wsClient.on('task:cancelled', (data: any) => {
      if (data?.task_id) merge({ id: data.task_id, status: 'cancelled' });
    });
    // 活跃任务进度兜底轮询（引擎当前只在成功时写 progress=100，不发 progress 事件）：
    // 仅刷新会话内活跃任务的进度/状态，绝不把历史任务注入通知列表
    pollTimer = setInterval(() => {
      const actives = get().tasks.filter((t) => isActive(t.status));
      if (actives.length === 0) return;
      void (async () => {
        try {
          const data = (await apiClient.get('/tasks')) as unknown as TaskItem[];
          const byId = new Map((data ?? []).map((t) => [t.id, t]));
          for (const t of actives) {
            const fresh = byId.get(t.id);
            if (!fresh) continue;
            merge({
              id: t.id,
              status: fresh.status,
              progress: fresh.progress,
              error_msg: fresh.error_msg,
            });
          }
        } catch {
          /* 后端不可用时保留现状 */
        }
      })();
    }, 5000);
  },

  stopWatch: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    watching = false;
  },
}));
