import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { wsClient } from '@/services/ws-client';
import type { AIGCTask, Asset, GenerateOptions, ImageGenResponse } from '@/types/aigc';

interface AIGCStore {
  tasks: AIGCTask[];
  assets: Asset[];
  generating: boolean;

  createImageTask: (prompt: string, options?: GenerateOptions) => Promise<string>;
  fetchAssets: (novelId: number) => Promise<void>;
  deleteAsset: (assetId: number) => Promise<void>;
  pollTaskStatus: (taskId: string) => Promise<void>;
  updateTaskProgress: (taskId: string, progress: number) => void;
  markTaskCompleted: (taskId: string) => void;
  markTaskFailed: (taskId: string) => void;
}

export const useAIGCStore = create<AIGCStore>((set, get) => ({
  tasks: [],
  assets: [],
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

      // Start polling
      get().pollTaskStatus(taskId);

      return taskId;
    } catch (err) {
      set({ generating: false });
      throw err;
    }
  },

  pollTaskStatus: async (taskId) => {
    const poll = async () => {
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
          return;
        }

        // Continue polling after 2 seconds
        setTimeout(poll, 2000);
      } catch {
        set({ generating: false });
      }
    };

    await poll();
  },

  fetchAssets: async (novelId) => {
    try {
      const data = (await apiClient.get('/aigc/assets', {
        params: { novel_id: novelId },
      })) as any;
      const assets: Asset[] = Array.isArray(data) ? data : [];
      set({ assets });
    } catch (err) {
      console.error('fetchAssets failed', err);
      set({ assets: [] });
    }
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
  }
});

wsClient.on('task:failed', (data) => {
  const taskId = data.task_id as string;
  if (taskId) {
    useAIGCStore.getState().markTaskFailed(taskId);
  }
});
