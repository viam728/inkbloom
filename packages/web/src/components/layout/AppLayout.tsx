import React, { useCallback, useEffect, useRef } from 'react';
import { PanelLeftOpen, PanelRightOpen, BarChart3 } from 'lucide-react';
import { useUIStore, LEFT_MIN, LEFT_MAX, RIGHT_MIN, RIGHT_MAX, ANALYSIS_MIN, ANALYSIS_MAX } from '@/stores/ui-store';
import LeftPanel from '@/components/panels/LeftPanel';
import EditorArea from '@/components/editor/EditorArea';
import MediaEditorArea from '@/components/media/MediaEditorArea';
import RightPanel from '@/components/panels/RightPanel';
import StoryAnalysisPanel from '@/components/analysis/StoryAnalysisPanel';
import CommandPalette from '@/components/layout/CommandPalette';
import ShortcutsDialog from '@/components/layout/ShortcutsDialog';
import MemoPad from '@/components/memo/MemoPad';
import DashboardModal from '@/components/insights/DashboardModal';
import RhythmModal from '@/components/insights/RhythmModal';
import InspirationModal from '@/components/insights/InspirationModal';

/** 拖拽调整宽度的手柄 */
const ResizeHandle: React.FC<{
  side: 'left' | 'right';
  onDelta: (deltaX: number) => void;
}> = ({ side, onDelta }) => {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    lastX.current = e.clientX;
    document.body.classList.add('resizing');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - lastX.current;
    lastX.current = e.clientX;
    onDelta(side === 'left' ? delta : -delta);
  };

  const handlePointerUp = () => {
    dragging.current = false;
    document.body.classList.remove('resizing');
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
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

      // 编辑区/输入框内时，避免与编辑器内置快捷键（如 Ctrl+B 加粗）冲突
      const target = e.target as HTMLElement;
      const inEditable = !!target?.closest?.('[contenteditable="true"], input, textarea');

      if (key === 'b' && !e.shiftKey) {
        if (inEditable) return;
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

  const handleLeftDelta = useCallback(
    (delta: number) => setLeftWidth(useUIStore.getState().leftWidth + delta),
    [setLeftWidth],
  );
  const handleRightDelta = useCallback(
    (delta: number) => setRightWidth(useUIStore.getState().rightWidth + delta),
    [setRightWidth],
  );
  const handleAnalysisDelta = useCallback(
    (delta: number) => setAnalysisWidth(useUIStore.getState().analysisWidth + delta),
    [setAnalysisWidth],
  );

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

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
      {!focusMode &&
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
            <ResizeHandle side="left" onDelta={handleLeftDelta} />
          </>
        ))}

      {/* ===== 编辑区（按角色差异化） ===== */}
      {role === 'media' ? <MediaEditorArea /> : <EditorArea />}

      {/* ===== 右侧栏 ===== */}
      {!focusMode &&
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
            <ResizeHandle side="right" onDelta={handleRightDelta} />
            <div
              className="shrink-0 h-full overflow-hidden animate-fade-in"
              style={{ width: clamp(rightWidth, RIGHT_MIN, RIGHT_MAX) }}
            >
              <RightPanel />
            </div>
          </>
        ))}

      {/* ===== 分析面板（第四面板） ===== */}
      {!focusMode &&
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
            <ResizeHandle side="right" onDelta={handleAnalysisDelta} />
            <div
              className="shrink-0 h-full overflow-hidden animate-fade-in"
              style={{ width: clamp(analysisWidth, ANALYSIS_MIN, ANALYSIS_MAX) }}
            >
              <StoryAnalysisPanel />
            </div>
          </>
        ))}

      {/* 全局浮层 */}
      <CommandPalette />
      <ShortcutsDialog />
      <DashboardModal />
      <RhythmModal />
      <InspirationModal />
    </div>
  );
};

export default AppLayout;
