import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { wsClient } from '@/services/ws-client';

/** 后台任务（tasks 表）在任务面板中的展示形态 */
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

interface TaskStore {
  tasks: TaskItem[];
  loading: boolean;
  /** 拉取当前用户任务列表（GET /tasks，默认 limit 50） */
  load: () => Promise<void>;
  /** 中止任务（POST /tasks/:id/cancel）；暂停语义对当前任务类型无意义，统一为中止 */
  cancel: (id: string) => Promise<void>;
  /** 开始监听 WS 任务事件（终态事件触发刷新）；幂等 */
  startWatch: () => void;
}

let watching = false;

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const data = (await apiClient.get('/tasks')) as unknown as TaskItem[];
      set({ tasks: data ?? [] });
    } catch {
      /* 后端不可用时保留现状 */
    } finally {
      set({ loading: false });
    }
  },

  cancel: async (id) => {
    await apiClient.post(`/tasks/${id}/cancel`);
    await get().load();
  },

  startWatch: () => {
    if (watching) return;
    watching = true;
    // 终态事件（NATS→WS bridge 转发）：刷新列表。活跃任务进度由下方轮询兜底
    // （引擎当前只在成功时写 progress=100，不发 progress 事件）。
    const refresh = () => void get().load();
    wsClient.on('task:completed', refresh);
    wsClient.on('task:dead_letter', refresh);
    wsClient.on('task:cancelled', refresh);
    // 活跃任务轮询（5s）：仅存在活跃任务时拉取（模块级 watch 与页面同生命周期）
    setInterval(() => {
      if (get().tasks.some((t) => isActive(t.status))) void get().load();
    }, 5000);
  },
}));
