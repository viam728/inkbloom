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
export type LeftTab = 'library' | 'outline' | 'architecture' | 'memory' | 'contents' | 'topics';

/**
 * 大纲顺序标签渲染模式（节点/幕标题头顺序标签，点击循环切换；备忘录 L61）：
 * cn = 第一章（中文，默认）/ num = 1（数字）/ blank = 不含文字的节点标（无文字小标记）。
 * 旧值 'hidden'（曾误实现为隐藏）在 migrate 中映射为 'blank'。
 */
export type OutlineNumMode = 'cn' | 'num' | 'blank';

/** 右侧面板 Tab（按角色展示不同子集） */
export type RightTab =
  | 'chat'
  | 'story'
  | 'review'
  | 'aigc'
  | 'title'
  | 'gallery'
  | 'tracker'
  | 'tasks'
  | 'insight';

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
  inspirationOpen: boolean;
  /** 右侧板「洞察」Tab 当前子视图（节奏/仪表盘/灵感包，供命令面板深链） */
  insightView: 'rhythm' | 'dashboard' | 'inspiration';
  /** 大纲顺序标签渲染模式：第一章(cn，默认) / 1(num) / 不含文字的节点标(blank)，点击循环 */
  outlineNumMode: OutlineNumMode;
  /** 卷标（幕标题头）顺序标签渲染模式：与章标独立切换 */
  actNumMode: OutlineNumMode;
  subscriptionOpen: boolean;
  tokenOpen: boolean;
  dataOpen: boolean;
  feedbackOpen: boolean;
  /** 章节版本历史抽屉（业务方案 v3 E1） */
  historyOpen: boolean;
    /** 整本里程碑快照抽屉（Agent safety work Q3） */
    novelVersionOpen: boolean;
  /**
   * 写作侧边主动提示条开关（业务方案 v3 A15）。
   * 默认开启：主动提醒的价值就在于"不用你记得去看"，默认关闭等于没有。
   * 关闭后持久化，不再打扰。
   */
  hintBarEnabled: boolean;

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
  setInspirationOpen: (open: boolean) => void;
  setInsightView: (view: 'rhythm' | 'dashboard' | 'inspiration') => void;
  /** 循环大纲顺序标签渲染：cn → num → blank → cn */
  cycleOutlineNumMode: () => void;
  /** 循环卷标（幕标题头）顺序标签渲染：与章标独立 */
  cycleActNumMode: () => void;
  setSubscriptionOpen: (open: boolean) => void;
  setTokenOpen: (open: boolean) => void;
  setDataOpen: (open: boolean) => void;
  setFeedbackOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
    setNovelVersionOpen: (open: boolean) => void;
  setHintBarEnabled: (enabled: boolean) => void;
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
      inspirationOpen: false,
      insightView: 'dashboard',
      outlineNumMode: 'num',
      actNumMode: 'cn',
      subscriptionOpen: false,
      tokenOpen: false,
      dataOpen: false,
      feedbackOpen: false,
      historyOpen: false,
            novelVersionOpen: false,
      hintBarEnabled: true,

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
      setInspirationOpen: (open) => set({ inspirationOpen: open }),
      setInsightView: (view) => set({ insightView: view }),
      cycleOutlineNumMode: () =>
        set((s) => ({
          outlineNumMode:
            s.outlineNumMode === 'cn' ? 'num' : s.outlineNumMode === 'num' ? 'blank' : 'cn',
        })),
      cycleActNumMode: () =>
        set((s) => ({
          actNumMode:
            s.actNumMode === 'cn' ? 'num' : s.actNumMode === 'num' ? 'blank' : 'cn',
        })),
      setSubscriptionOpen: (open) => set({ subscriptionOpen: open }),
      setTokenOpen: (open) => set({ tokenOpen: open }),
      setDataOpen: (open) => set({ dataOpen: open }),
      setFeedbackOpen: (open) => set({ feedbackOpen: open }),
      setHistoryOpen: (open) => set({ historyOpen: open }),
            setNovelVersionOpen: (open) => set({ novelVersionOpen: open }),
      setHintBarEnabled: (enabled) => set({ hintBarEnabled: enabled }),
    }),
    {
      name: 'inkbloom-ui',
      version: 2,
      // v1 → v2：旧第三态 'hidden'（误实现为隐藏）迁移为 'blank'（不含文字的节点标）
      migrate: (persisted: unknown) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        if (p.outlineNumMode === 'hidden') p.outlineNumMode = 'blank';
        if (p.actNumMode === 'hidden') p.actNumMode = 'blank';
        return p as never;
      },
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
        // 大纲顺序标签渲染模式：持久化（备忘录 L61 顺序标签三态切换）
        outlineNumMode: s.outlineNumMode,
        // 卷标（幕标题头）渲染模式：与章标独立持久化
        actNumMode: s.actNumMode,
        // 主动提示开关：持久化，关闭后不再打扰（业务方案 v3 A15）
        hintBarEnabled: s.hintBarEnabled,
      }),
    },
  ),
);
