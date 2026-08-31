import { create } from 'zustand';
import * as storyApi from '@/services/story-client';
import type { StoryJob, StoryStage, StoryJobConfig } from '@/services/story-client';
import { toast } from '@/components/common/Toast';

interface StoryStoreState {
  jobs: StoryJob[];
  activeJob: StoryJob | null;
  loading: boolean;
  generating: boolean;
  adopting: boolean;

  loadJobs: (novelId?: number) => Promise<void>;
  openJob: (id: number) => Promise<void>;
  closeJob: () => void;
  createJob: (req: { novel_id: number; title: string; logline: string; config?: StoryJobConfig }) => Promise<StoryJob>;
  generateStage: (id: number) => Promise<void>;
  advanceStage: (id: number) => Promise<void>;
  jumpStage: (id: number, target: StoryStage) => Promise<void>;
  adoptChapter: (id: number, req: { chapter_key: string; title: string; content: string }) => Promise<void>;
  removeJob: (id: number) => Promise<void>;
  refreshActive: () => Promise<void>;
}

export const useStoryStore = create<StoryStoreState>((set, get) => ({
  jobs: [],
  activeJob: null,
  loading: false,
  generating: false,
  adopting: false,

  loadJobs: async (novelId?: number) => {
    set({ loading: true });
    try {
      const res = await storyApi.listStoryJobs({ novelId });
      set({ jobs: res.jobs ?? [] });
    } catch (e) {
      console.error('load story jobs failed', e);
    } finally {
      set({ loading: false });
    }
  },

  openJob: async (id: number) => {
    try {
      const job = await storyApi.getStoryJob(id);
      set({ activeJob: job });
    } catch (e) {
      console.error('open story job failed', e);
      toast.show('加载创作任务失败', 'error');
    }
  },

  closeJob: () => set({ activeJob: null }),

  createJob: async (req) => {
    const job = await storyApi.createStoryJob(req);
    set((s) => ({ jobs: [job, ...s.jobs] }));
    toast.show('创作任务已创建，点击开始生成', 'success');
    return job;
  },

  generateStage: async (id: number) => {
    set({ generating: true });
    try {
      const job = await storyApi.generateStoryStage(id);
      set((s) => ({
        activeJob: s.activeJob?.id === id ? job : s.activeJob,
        jobs: s.jobs.map((j) => (j.id === id ? job : j)),
      }));
    } catch (e) {
      console.error('generate story stage failed', e);
      toast.show('生成失败，请重试', 'error');
      throw e;
    } finally {
      set({ generating: false });
    }
  },

  advanceStage: async (id: number) => {
    const job = await storyApi.advanceStoryStage(id);
    set((s) => ({
      activeJob: s.activeJob?.id === id ? job : s.activeJob,
      jobs: s.jobs.map((j) => (j.id === id ? job : j)),
    }));
  },

  jumpStage: async (id: number, target: StoryStage) => {
    // 滑动选择器：直接设置阶段（任意顺序），不限定线性推进。
    try {
      const job = await storyApi.setStoryStage(id, target);
      set((s) => ({
        activeJob: s.activeJob?.id === id ? job : s.activeJob,
        jobs: s.jobs.map((j) => (j.id === id ? job : j)),
      }));
    } catch (e) {
      console.error('jumpStage failed', e);
      toast.show('切换阶段失败', 'error');
    }
  },

  adoptChapter: async (id, req) => {
    set({ adopting: true });
    try {
      const job = await storyApi.adoptStoryChapter(id, req);
      set((s) => ({
        activeJob: s.activeJob?.id === id ? job : s.activeJob,
        jobs: s.jobs.map((j) => (j.id === id ? job : j)),
      }));
      toast.show('已采纳到章节', 'success');
    } catch (e) {
      console.error('adopt chapter failed', e);
      toast.show('采纳失败', 'error');
      throw e;
    } finally {
      set({ adopting: false });
    }
  },

  removeJob: async (id: number) => {
    await storyApi.deleteStoryJob(id);
    set((s) => ({
      jobs: s.jobs.filter((j) => j.id !== id),
      activeJob: s.activeJob?.id === id ? null : s.activeJob,
    }));
  },

  refreshActive: async () => {
    const { activeJob } = get();
    if (!activeJob) return;
    try {
      const job = await storyApi.getStoryJob(activeJob.id);
      set({ activeJob: job });
    } catch {
      // ignore refresh errors
    }
  },
}));

/** 阶段顺序（进度展示用） */
export const STAGE_ORDER: StoryStage[] = [
  'idea',
  'outline',
  'plan_chapters',
  'draft_chapter',
  'verify',
  'finalize',
  'done',
];
