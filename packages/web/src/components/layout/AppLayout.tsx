import React, { useCallback, useEffect, useRef } from 'react';
import { PanelLeftOpen, PanelRightOpen, BarChart3 } from 'lucide-react';
import { useUIStore, LEFT_MIN, LEFT_MAX, RIGHT_MIN, RIGHT_MAX, ANALYSIS_MIN, ANALYSIS_MAX } from '@/stores/ui-store';
import LeftPanel from '@/components/panels/LeftPanel';
import EditorArea from '@/components/editor/EditorArea';
import MediaEditorArea from '@/components/media/MediaEditorArea';
import RightPanel from '@/components/panels/RightPanel';
import StoryAnalysisPanel from '@/components/analysis/StoryAnalysisPanel';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import CommandPalette from '@/components/layout/CommandPalette';
import ShortcutsDialog from '@/components/layout/ShortcutsDialog';
import MemoPad from '@/components/memo/MemoPad';
import DashboardModal from '@/components/insights/DashboardModal';
import RhythmModal from '@/components/insights/RhythmModal';
import InspirationModal from '@/components/insights/InspirationModal';
import HistoryPanel from '@/components/history/HistoryPanel';
import NovelVersionPanel from '@/components/history/NovelVersionPanel';

/** 拖拽调整宽度的手柄：raf 节流 + 双击折叠/还原 */
const ResizeHandle: React.FC<{
  side: 'left' | 'right';
  onDelta: (deltaX: number) => void;
  onDoubleClick: () => void;
}> = ({ side, onDelta, onDoubleClick }) => {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const pendingX = useRef(0);
  const rafId = useRef<number | null>(null);

  // 卸载时清理未消费的 raf
  useEffect(() => {
    return () => {
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    lastX.current = e.clientX;
    pendingX.current = e.clientX;
    document.body.classList.add('resizing');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    pendingX.current = e.clientX;
    // requestAnimationFrame 节流：每帧最多消费一次位移
    if (rafId.current != null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      if (!dragging.current) return;
      const delta = pendingX.current - lastX.current;
      if (delta === 0) return;
      lastX.current = pendingX.current;
      onDelta(side === 'left' ? delta : -delta);
    });
  };

  const handlePointerUp = () => {
    dragging.current = false;
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    document.body.classList.remove('resizing');
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={onDoubleClick}
      className="group relative w-[3px] shrink-0 cursor-col-resize z-10 -mx-[1px]"
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-transparent group-hover:bg-brand-500/60 group-active:bg-brand-400 transition-colors" />
    </div>
  );
};

const AppLayout: React.FC = () => {
  const {
    leftWidth,
    rightWidth,
    analysisWidth,
    leftCollapsed,
    rightCollapsed,
    analysisCollapsed,
    editorMaximized,
    focusMode,
    role,
    setLeftWidth,
    setRightWidth,
    setAnalysisWidth,
    toggleLeft,
    toggleRight,
    toggleAnalysis,
    toggleFocusMode,
    togglePalette,
    toggleShortcuts,
  } = useUIStore();

  // 全局快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      // F2-8（X-9）：编辑区/输入框内时，全部布局快捷键让位给编辑器内置快捷键
      // （此前仅 Ctrl+B 判断，Ctrl+I 会同时切斜体与分析面板、Ctrl+J/K 同理冲突）
      const target = e.target as HTMLElement;
      const inEditable = !!target?.closest?.('[contenteditable="true"], input, textarea');
      if (inEditable) return;

      if (key === 'b' && !e.shiftKey) {
        e.preventDefault();
        toggleLeft();
      } else if (key === 'j') {
        e.preventDefault();
        toggleRight();
      } else if (key === 'k') {
        e.preventDefault();
        togglePalette();
      } else if (key === '/') {
        e.preventDefault();
        toggleShortcuts();
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        toggleFocusMode();
      } else if (key === 'i') {
        e.preventDefault();
        toggleAnalysis();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleLeft, toggleRight, toggleAnalysis, togglePalette, toggleShortcuts, toggleFocusMode]);

  // 拖拽越界（低于 MIN）自动折叠：toggleLeft/toggleRight 会记录折叠前宽度供还原
  const handleLeftDelta = useCallback(
    (delta: number) => {
      const s = useUIStore.getState();
      if (s.leftWidth + delta < LEFT_MIN) {
        if (!s.leftCollapsed) s.toggleLeft();
        return;
      }
      setLeftWidth(s.leftWidth + delta);
    },
    [setLeftWidth],
  );
  const handleRightDelta = useCallback(
    (delta: number) => {
      const s = useUIStore.getState();
      if (s.rightWidth + delta < RIGHT_MIN) {
        if (!s.rightCollapsed) s.toggleRight();
        return;
      }
      setRightWidth(s.rightWidth + delta);
    },
    [setRightWidth],
  );
  const handleAnalysisDelta = useCallback(
    (delta: number) => setAnalysisWidth(useUIStore.getState().analysisWidth + delta),
    [setAnalysisWidth],
  );

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

  // 最大化/专注模式：渲染层隐藏全部侧栏（不改 collapsed 持久态，退出后恢复原状）
  const chromeHidden = focusMode || editorMaximized;

  // 简约随记模式：整屏切换为轻量笔记界面
  if (role === 'memo') {
    return (
      <div className="flex flex-1 min-h-0 w-full overflow-hidden bg-surface-0 text-neutral-100 relative">
        <MemoPad />
        {/* 全局浮层 */}
        <CommandPalette />
        <ShortcutsDialog />
        <DashboardModal />
        <InspirationModal />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 w-full overflow-hidden bg-surface-0 text-neutral-100 relative">
      {/* ===== 左侧栏 ===== */}
      {!chromeHidden &&
        (leftCollapsed ? (
          <button
            onClick={toggleLeft}
            title="展开侧边栏 (Ctrl+B)"
            className="shrink-0 w-9 h-full flex flex-col items-center pt-4 gap-3 border-r border-white/6 bg-surface-1 hover:bg-surface-2 text-neutral-500 hover:text-brand-400 transition-colors"
          >
            <PanelLeftOpen size={16} />
            <span className="text-[10px] tracking-widest [writing-mode:vertical-lr] select-none">
              作品目录
            </span>
          </button>
        ) : (
          <>
            <div
              className="shrink-0 h-full overflow-hidden animate-fade-in"
              style={{ width: clamp(leftWidth, LEFT_MIN, LEFT_MAX) }}
            >
              <LeftPanel />
            </div>
            <ResizeHandle side="left" onDelta={handleLeftDelta} onDoubleClick={toggleLeft} />
          </>
        ))}

      {/* ===== 编辑区（按角色差异化） ===== */}
      {role === 'media' ? <MediaEditorArea /> : <EditorArea />}

      {/* ===== 右侧栏 ===== */}
      {!chromeHidden &&
        (rightCollapsed ? (
          <button
            onClick={toggleRight}
            title="展开 AI 面板 (Ctrl+J)"
            className="shrink-0 w-9 h-full flex flex-col items-center pt-4 gap-3 border-l border-white/6 bg-surface-1 hover:bg-surface-2 text-neutral-500 hover:text-brand-400 transition-colors"
          >
            <PanelRightOpen size={16} />
            <span className="text-[10px] tracking-widest [writing-mode:vertical-lr] select-none">
              AI 助手
            </span>
          </button>
        ) : (
          <>
            <ResizeHandle side="right" onDelta={handleRightDelta} onDoubleClick={toggleRight} />
            <div
              className="shrink-0 h-full overflow-hidden animate-fade-in"
              style={{ width: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }}
            >
              <RightPanel />
            </div>
          </>
        ))}

      {/* ===== 分析面板（第四面板） ===== */}
      {!chromeHidden &&
        (analysisCollapsed ? (
          <button
            onClick={toggleAnalysis}
            title="展开整体分析 (Ctrl+I)"
            className="shrink-0 w-9 h-full flex flex-col items-center pt-4 gap-3 border-l border-white/6 bg-surface-1 hover:bg-surface-2 text-neutral-500 hover:text-brand-400 transition-colors"
          >
            <BarChart3 size={16} />
            <span className="text-[10px] tracking-widest [writing-mode:vertical-lr] select-none">
              整体分析
            </span>
          </button>
        ) : (
          <>
            <ResizeHandle side="right" onDelta={handleAnalysisDelta} onDoubleClick={toggleAnalysis} />
            <div
              className="shrink-0 h-full overflow-hidden animate-fade-in"
              style={{ width: clamp(analysisWidth, ANALYSIS_MIN, ANALYSIS_MAX) }}
            >
              <ErrorBoundary label="整体分析面板">
                <StoryAnalysisPanel />
              </ErrorBoundary>
            </div>
          </>
        ))}

      {/* 全局浮层 */}
      <CommandPalette />
      <ShortcutsDialog />
      <DashboardModal />
      <RhythmModal />
      <InspirationModal />
      {/* 章节版本历史（业务方案 v3 E1） */}
      <HistoryPanel />
            {/* 整本里程碑快照（Agent safety work Q3） */}
            <NovelVersionPanel />
    </div>
  );
};

export default AppLayout;
