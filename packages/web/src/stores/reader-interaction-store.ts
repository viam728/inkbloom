import { create } from 'zustand';

/**
 * 阅读器互动面板的跨组件信号（业务方案 v3 E5，施工任务 A29）。
 *
 * 面板本体（ReaderInteractions）持有互动数据，这里只存「是否打开 +
 * 评论上下文 + 刷新版本号」——ChapterReader 的段落悬停/选中交互通过
 * openComposer 传入锚点，情绪点击后 bump 触发面板重新拉取。
 */
export interface ComposerContext {
  block_index: number;
  anchor: string;
}

interface ReaderInteractionState {
  open: boolean;
  composer: ComposerContext | null;
  version: number;
  setOpen: (open: boolean) => void;
  openComposer: (ctx?: ComposerContext | null) => void;
  bump: () => void;
}

export const useReaderInteractionStore = create<ReaderInteractionState>((set) => ({
  open: false,
  composer: null,
  version: 0,
  setOpen: (open) => set({ open }),
  openComposer: (composer = null) => set({ open: true, composer }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
