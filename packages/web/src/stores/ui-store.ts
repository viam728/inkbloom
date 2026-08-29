import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const LEFT_MIN = 200;
export const LEFT_MAX = 420;
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 480;
export const ANALYSIS_MIN = 240;
export const ANALYSIS_MAX = 460;

/** 创作者角色 */
export type CreatorRole = 'novelist' | 'media' | 'memo';

/** 左侧面板 Tab（按角色展示不同子集） */
export type LeftTab = 'library' | 'outline' | 'memory' | 'contents' | 'topics';

/** 右侧面板 Tab（按角色展示不同子集） */
export type RightTab = 'chat' | 'review' | 'aigc' | 'title' | 'gallery' | 'tracker';

interface UIState {
  leftWidth: number;
  rightWidth: number;
  /** 第四面板（整体分析）宽度 */
  analysisWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** 第四面板（整体分析）折叠态 */
  analysisCollapsed: boolean;
  /** 折叠前宽度：双击手柄/拖拽越界折叠时记录，还原时恢复 */
  prevLeftWidth: number;
  prevRightWidth: number;
  /** 编辑区最大化：隐藏左/右/分析面板（渲染层，不改 collapsed 持久态） */
  editorMaximized: boolean;
  focusMode: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** 创作者角色：小说作者 / 自媒体作者 / 简约随记 */
  role: CreatorRole;
  /** 左侧面板当前 Tab */
  leftTab: LeftTab;
  /** 右侧面板当前 Tab（全局可写，供命令面板/AIGC 等外部跳转） */
  activeRightTab: RightTab;
  /** 全局弹窗 */
  dashboardOpen: boolean;
  rhythmOpen: boolean;
  inspirationOpen: boolean;
  subscriptionOpen: boolean;
  tokenOpen: boolean;
  dataOpen: boolean;
  feedbackOpen: boolean;
  /** 章节版本历史抽屉（业务方案 v3 E1） */
  historyOpen: boolean;

  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setAnalysisWidth: (w: number) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleAnalysis: () => void;
  toggleEditorMaximized: () => void;
  toggleFocusMode: () => void;
  exitFocusMode: () => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setShortcutsOpen: (open: boolean) => void;
  toggleShortcuts: () => void;
  setRole: (role: CreatorRole) => void;
  setLeftTab: (tab: LeftTab) => void;
  setActiveRightTab: (tab: RightTab) => void;
  setDashboardOpen: (open: boolean) => void;
  setRhythmOpen: (open: boolean) => void;
  setInspirationOpen: (open: boolean) => void;
  setSubscriptionOpen: (open: boolean) => void;
  setTokenOpen: (open: boolean) => void;
  setDataOpen: (open: boolean) => void;
  setFeedbackOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      leftWidth: 250,
      rightWidth: 320,
      analysisWidth: 300,
      leftCollapsed: false,
      rightCollapsed: false,
      analysisCollapsed: true,
      prevLeftWidth: 250,
      prevRightWidth: 320,
      editorMaximized: false,
      focusMode: false,
      paletteOpen: false,
      shortcutsOpen: false,
      role: 'novelist',
      leftTab: 'library',
      activeRightTab: 'chat',
      dashboardOpen: false,
      rhythmOpen: false,
      inspirationOpen: false,
      subscriptionOpen: false,
      tokenOpen: false,
      dataOpen: false,
      feedbackOpen: false,
      historyOpen: false,

      setLeftWidth: (w) =>
        set({ leftWidth: Math.min(LEFT_MAX, Math.max(LEFT_MIN, w)), leftCollapsed: false }),
      setRightWidth: (w) =>
        set({ rightWidth: Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, w)), rightCollapsed: false }),
      setAnalysisWidth: (w) =>
        set({ analysisWidth: Math.min(ANALYSIS_MAX, Math.max(ANALYSIS_MIN, w)), analysisCollapsed: false }),
      toggleLeft: () =>
        set((s) =>
          s.leftCollapsed
            ? { leftCollapsed: false, leftWidth: s.prevLeftWidth || s.leftWidth }
            : { leftCollapsed: true, prevLeftWidth: s.leftWidth },
        ),
      toggleRight: () =>
        set((s) =>
          s.rightCollapsed
            ? { rightCollapsed: false, rightWidth: s.prevRightWidth || s.rightWidth }
            : { rightCollapsed: true, prevRightWidth: s.rightWidth },
        ),
      toggleAnalysis: () => set((s) => ({ analysisCollapsed: !s.analysisCollapsed })),
      toggleEditorMaximized: () => set((s) => ({ editorMaximized: !s.editorMaximized })),
      toggleFocusMode: () =>
        set((s) => ({ focusMode: !s.focusMode })),
      exitFocusMode: () => set({ focusMode: false }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),
      setRole: (role) =>
        set({
          role,
          focusMode: false,
          leftTab: role === 'media' ? 'contents' : 'library',
        }),
      setLeftTab: (tab) => set({ leftTab: tab }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      setDashboardOpen: (open) => set({ dashboardOpen: open }),
      setRhythmOpen: (open) => set({ rhythmOpen: open }),
      setInspirationOpen: (open) => set({ inspirationOpen: open }),
      setSubscriptionOpen: (open) => set({ subscriptionOpen: open }),
      setTokenOpen: (open) => set({ tokenOpen: open }),
      setDataOpen: (open) => set({ dataOpen: open }),
      setFeedbackOpen: (open) => set({ feedbackOpen: open }),
      setHistoryOpen: (open) => set({ historyOpen: open }),
    }),
    {
      name: 'inkbloom-ui',
      partialize: (s) => ({
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        analysisWidth: s.analysisWidth,
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
        analysisCollapsed: s.analysisCollapsed,
        prevLeftWidth: s.prevLeftWidth,
        prevRightWidth: s.prevRightWidth,
        role: s.role,
        leftTab: s.leftTab,
        activeRightTab: s.activeRightTab,
      }),
    },
  ),
);
