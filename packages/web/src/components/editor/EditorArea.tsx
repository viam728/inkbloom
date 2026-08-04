import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PenLine,
  Check,
  CloudUpload,
  AlertCircle,
  Focus,
  Minimize,
  BookOpenText,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useEditorStore } from '@/stores/editor-store';
import { useUIStore } from '@/stores/ui-store';
import { useStatsStore } from '@/stores/stats-store';
import TipTapEditor from './TipTapEditor';
import ExportDialog from '@/components/export/ExportDialog';
import PlatformLinks from '@/components/export/PlatformLinks';
import Kbd from '@/components/common/Kbd';

const EditorArea: React.FC = () => {
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const { content, wordCount, saveStatus, isDirty, setContent, setWordCount, saveChapter, resetDirty } =
    useEditorStore();
  const focusMode = useUIStore((s) => s.focusMode);
  const toggleFocusMode = useUIStore((s) => s.toggleFocusMode);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // 写作统计：跟踪字数增量，正增长计入当日仪表盘
  const addWords = useStatsStore((s) => s.addWords);
  const prevWordRef = useRef(0);
  const handleWordCount = useCallback(
    (count: number) => {
      const delta = count - prevWordRef.current;
      if (delta > 0) addWords(delta);
      prevWordRef.current = count;
      setWordCount(count);
    },
    [addWords, setWordCount],
  );

  // 切换章节时重置编辑器状态（以当前字数为基线，避免全文被计为新增）
  // 依赖 content：内容可能在选中后异步到达（后端降级加载），需再次同步
  useEffect(() => {
    const plain = (currentChapter?.content || '').replace(/<[^>]+>/g, '');
    const cn = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
    const en = (plain.match(/[a-zA-Z]+/g) || []).length;
    prevWordRef.current = cn + en;
    if (currentChapter) {
      resetDirty();
      setContent(currentChapter.content || '');
    } else {
      resetDirty();
    }
  }, [currentChapter?.id, currentChapter?.content]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自动保存：内容变化后 2s 防抖保存
  const handleChange = useCallback(
    (html: string) => {
      setContent(html);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (currentChapter) {
        saveTimerRef.current = setTimeout(() => {
          saveChapter(currentChapter.id);
        }, 2000);
      }
    },
    [currentChapter, setContent, saveChapter]
  );

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // 欢迎页
  if (!currentChapter) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
        {/* 背景光晕 */}
        <div className="absolute top-1/4 left-1/3 w-72 h-72 rounded-full bg-indigo-600/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

        <div className="text-center animate-fade-in-slow relative">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-pink-500/20 border border-white/8 flex items-center justify-center mb-5">
            <PenLine size={28} className="text-brand-300" />
          </div>
          <h2 className="text-xl font-semibold mb-2 text-neutral-200">InkBloom 编辑器</h2>
          <p className="text-sm text-neutral-500 mb-6">选择或创建一个章节开始写作</p>
          <div className="flex items-center justify-center gap-2 text-[11px] text-neutral-600">
            <span className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd> 快速跳转
            </span>
            <span className="mx-1 text-neutral-700">·</span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>/</Kbd> 快捷键帮助
            </span>
          </div>
        </div>
      </div>
    );
  }

  // 阅读时长估算（500 字/分钟）
  const readingMinutes = Math.max(1, Math.round(wordCount / 500));

  const saveStatusConfig: Record<
    string,
    { icon: React.ReactNode; label: string; className: string }
  > = {
    idle: { icon: null, label: '', className: 'text-neutral-500' },
    saving: {
      icon: <CloudUpload size={12} className="animate-pulse-soft" />,
      label: '保存中…',
      className: 'text-amber-400',
    },
    saved: { icon: <Check size={12} />, label: '已保存', className: 'text-emerald-400' },
    error: { icon: <AlertCircle size={12} />, label: '保存失败', className: 'text-red-400' },
  };

  const status = isDirty && saveStatus === 'idle'
    ? { icon: <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-soft" />, label: '未保存', className: 'text-amber-400' }
    : saveStatusConfig[saveStatus];

  return (
    <div className={`flex-1 flex flex-col min-w-0 bg-surface-0 ${focusMode ? 'focus-mode' : ''}`}>
      {/* 章节标题栏（专注模式下隐藏） */}
      {!focusMode && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/6 bg-surface-1/60">
          <BookOpenText size={14} className="text-neutral-500 shrink-0" />
          <h3 className="text-sm font-medium text-neutral-200 truncate flex-1">
            {currentChapter.title}
          </h3>
          <button
            onClick={toggleFocusMode}
            title="进入专注模式 (Ctrl+Shift+F)"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
          >
            <Focus size={13} />
            专注
          </button>
        </div>
      )}

      {/* 专注模式退出按钮 */}
      {focusMode && (
        <div className="absolute top-4 right-4 z-30 animate-fade-in">
          <button
            onClick={toggleFocusMode}
            title="退出专注模式 (Esc)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-panel text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <Minimize size={13} />
            退出专注
          </button>
        </div>
      )}

      {/* 编辑器 */}
      <div className="flex-1 overflow-hidden relative">
        <TipTapEditor
          key={currentChapter.id}
          content={content}
          onChange={handleChange}
          onWordCount={handleWordCount}
          onExport={() => setExportOpen(true)}
        />
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-white/6 bg-surface-1/60 text-xs text-neutral-500">
        <div className="flex items-center gap-3">
          <span className="tabular-nums">{wordCount.toLocaleString()} 字</span>
          <span className="text-neutral-700">|</span>
          <span className="tabular-nums">约 {readingMinutes} 分钟阅读</span>
          <span className="text-neutral-700">|</span>
          <PlatformLinks />
        </div>
        {status.icon && (
          <span className={`flex items-center gap-1.5 ${status.className} animate-fade-in`}>
            {status.icon}
            {status.label}
          </span>
        )}
      </div>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
};

export default EditorArea;
