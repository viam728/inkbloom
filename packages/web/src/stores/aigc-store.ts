import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { wsClient } from '@/services/ws-client';
import { toast } from '@/components/common/Toast';
import { useTaskStore } from '@/stores/task-store';
import type { AIGCTask, AigcRecord, Asset, GenerateOptions, ImageGenResponse } from '@/types/aigc';

/** /aigc/records 首拉上限：limit=48，最多翻 3 页 */
const RECORD_PAGE_LIMIT = 48;
const RECORD_MAX_PAGES = 3;

interface AIGCStore {
  tasks: AIGCTask[];
  assets: Asset[];
  /** AIGC 生成记录（不含 upload 图床图片） */
  records: AigcRecord[];
  recordsLoading: boolean;
  generating: boolean;

  createImageTask: (prompt: string, options?: GenerateOptions) => Promise<string>;
  fetchAssets: (novelId?: number) => Promise<void>;
  /** 拉取 AIGC 生成记录（novelId 缺省返全部，游标分页只拉前若干页） */
  fetchRecords: (novelId?: number) => Promise<void>;
  /** 从记录列表中移除（配合后端删除接口） */
  removeRecord: (recordId: number) => void;
  deleteAsset: (assetId: number) => Promise<void>;
  pollTaskStatus: (taskId: string) => Promise<void>;
  updateTaskProgress: (taskId: string, progress: number) => void;
  markTaskCompleted: (taskId: string) => void;
  markTaskFailed: (taskId: string) => void;
}

export const useAIGCStore = create<AIGCStore>((set, get) => ({
  tasks: [],
  assets: [],
  records: [],
  recordsLoading: false,
  generating: false,

  createImageTask: async (prompt, options = {}) => {
    set({ generating: true });
    try {
      const body = {
        prompt,
        width: options.width ?? 1024,
        height: options.height ?? 1024,
        provider: options.provider ?? 'pollinations',
        novel_id: options.novel_id,
        chapter_id: options.chapter_id,
      };

      const data = (await apiClient.post('/aigc/generate', body)) as unknown as ImageGenResponse;
      const taskId = data.task_id;

      // Add to local tasks list
      const task: AIGCTask = {
        id: taskId,
        type: 'image_gen',
        status: 'pending',
        progress: 0,
        prompt,
        provider: options.provider ?? 'pollinations',
      };
      set((s) => ({ tasks: [...s.tasks, task] }));
      // 备忘录 L61：任务同时登记进右侧板任务通知（会话临时，终态自动销毁）
      useTaskStore.getState().register({
        id: taskId,
        type: 'image_gen',
        status: 'pending',
        novel_id: options.novel_id ?? null,
        chapter_id: options.chapter_id ?? null,
      });

      // Start polling
      get().pollTaskStatus(taskId);

      return taskId;
    } catch (err) {
      set({ generating: false });
      throw err;
    }
  },

  pollTaskStatus: async (taskId) => {
    // F2-8（X-12）：轮询加上限与失败态 —— 卡 pending 的任务曾以 2s 间隔
    // 无限请求且失败只关 spinner，任务外观永远 pending、无提示无重试。
    const MAX_POLLS = 150; // 2s × 150 = 5 分钟
    let polls = 0;
    const poll = async () => {
      polls += 1;
      try {
        const data = (await apiClient.get(`/tasks/${taskId}`)) as any;
        const status: string = data?.status ?? 'pending';
        const progress: number = data?.progress ?? 0;

        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === taskId ? { ...t, status, progress } : t,
          ),
        }));

        if (status === 'success' || status === 'failed' || status === 'dead_letter') {
          set({ generating: false });
          if (status !== 'success') {
            toast.show('图片生成任务失败，请重试', 'error');
          }
          return;
        }

        if (polls >= MAX_POLLS) {
          set((s) => ({
            generating: false,
            tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: 'failed' } : t)),
          }));
          toast.show('图片生成超时，请重试', 'error');
          return;
        }

        // Continue polling after 2 seconds
        setTimeout(poll, 2000);
      } catch {
        set((s) => ({
          generating: false,
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: 'failed' } : t)),
        }));
        toast.show('图片生成任务查询失败，请重试', 'error');
      }
    };

    await poll();
  },

  fetchAssets: async (novelId) => {
    try {
      const data = (await apiClient.get('/aigc/assets', {
        params: novelId != null ? { novel_id: novelId } : undefined,
      })) as any;
      // novel_id 已可选：缺省返全部 AIGC，裸数组，兼容旧包裹结构
      const assets: Asset[] = Array.isArray(data) ? data : data?.items ?? [];
      set({ assets });
    } catch (err) {
      console.error('fetchAssets failed', err);
      set({ assets: [] });
    }
  },

  fetchRecords: async (novelId) => {
    set({ recordsLoading: true });
    try {
      const items: AigcRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < RECORD_MAX_PAGES; page++) {
        const data = (await apiClient.get('/aigc/records', {
          params: {
            novel_id: novelId,
            limit: RECORD_PAGE_LIMIT,
            cursor,
          },
        })) as unknown as { items?: AigcRecord[]; next_cursor?: string | null };
        items.push(...(data?.items ?? []));
        cursor = data?.next_cursor ?? undefined;
        if (!cursor) break;
      }
      set({ records: items });
    } catch (err) {
      console.error('fetchRecords failed', err);
      set({ records: [] });
    } finally {
      set({ recordsLoading: false });
    }
  },

  removeRecord: (recordId) => {
    set((s) => ({ records: s.records.filter((r) => r.id !== recordId) }));
  },

  deleteAsset: async (assetId) => {
    await apiClient.delete(`/aigc/assets/${assetId}`);
    set((s) => ({
      assets: s.assets.filter((a) => a.id !== assetId),
    }));
  },

  updateTaskProgress: (taskId, progress) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, progress, status: 'running' } : t,
      ),
    }));
  },

  markTaskCompleted: (taskId) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'success', progress: 100 } : t,
      ),
      generating: false,
    }));
  },

  markTaskFailed: (taskId) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' } : t,
      ),
      generating: false,
    }));
  },
}));

// WebSocket event subscriptions for real-time task updates
wsClient.on('task:progress', (data) => {
  const taskId = data.task_id as string;
  const progress = data.progress as number;
  if (taskId) {
    useAIGCStore.getState().updateTaskProgress(taskId, progress);
  }
});

wsClient.on('task:completed', (data) => {
  const taskId = data.task_id as string;
  if (taskId) {
    useAIGCStore.getState().markTaskCompleted(taskId);
    // 生图完成 → 静默刷新生成记录（后端返回后历史区即时可见）
    void useAIGCStore.getState().fetchRecords();
  }
});

wsClient.on('task:failed', (data) => {
  const taskId = data.task_id as string;
  if (taskId) {
    useAIGCStore.getState().markTaskFailed(taskId);
  }
});
