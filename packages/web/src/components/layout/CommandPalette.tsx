import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  BookOpen,
  FileText,
  Focus,
  PanelLeft,
  PanelRight,
  ImagePlus,
  Keyboard,
  CornerDownLeft,
  BarChart3,
  Activity,
  Lightbulb,
  MessageSquareQuote,
  Brain,
  ListOrdered,
  BookMarked,
  Megaphone,
  StickyNote,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import Kbd from '@/components/common/Kbd';

interface PaletteItem {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  keywords?: string;
  action: () => void;
}

const CommandPalette: React.FC = () => {
  const paletteOpen = useUIStore((s) => s.paletteOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleFocusMode = useUIStore((s) => s.toggleFocusMode);
  const toggleLeft = useUIStore((s) => s.toggleLeft);
  const toggleRight = useUIStore((s) => s.toggleRight);
  const toggleAnalysis = useUIStore((s) => s.toggleAnalysis);
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
  const setDashboardOpen = useUIStore((s) => s.setDashboardOpen);
  const setRhythmOpen = useUIStore((s) => s.setRhythmOpen);
  const setInspirationOpen = useUIStore((s) => s.setInspirationOpen);
  const setRole = useUIStore((s) => s.setRole);
  const setLeftTab = useUIStore((s) => s.setLeftTab);

  const { novels, chapters, selectNovel, selectChapter } = useNovelStore();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setPaletteOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setActiveIndex(0);
      // 等渲染后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();

    const actions: PaletteItem[] = [
      {
        id: 'act-focus',
        icon: <Focus size={15} className="text-brand-400" />,
        title: '切换专注写作模式',
        subtitle: 'Ctrl+Shift+F',
        keywords: 'focus zen 沉浸',
        action: () => toggleFocusMode(),
      },
      {
        id: 'act-left',
        icon: <PanelLeft size={15} className="text-neutral-400" />,
        title: '切换左侧边栏',
        subtitle: 'Ctrl+B',
        keywords: 'sidebar 侧栏',
        action: () => toggleLeft(),
      },
      {
        id: 'act-right',
        icon: <PanelRight size={15} className="text-neutral-400" />,
        title: '切换右侧 AI 面板',
        subtitle: 'Ctrl+J',
        keywords: 'ai panel 面板',
        action: () => toggleRight(),
      },
      {
        id: 'act-analysis',
        icon: <BarChart3 size={15} className="text-cyan-400" />,
        title: '打开整体分析面板',
        subtitle: 'Ctrl+I',
        keywords: 'analysis 分析 结构 角色图谱 节奏 诊断',
        action: () => {
          if (useUIStore.getState().analysisCollapsed) toggleAnalysis();
        },
      },
      {
        id: 'act-aigc',
        icon: <ImagePlus size={15} className="text-pink-400" />,
        title: '打开 AI 图片生成',
        keywords: 'aigc image 图片',
        action: () => window.dispatchEvent(new CustomEvent('inkbloom:show-aigc')),
      },
      {
        id: 'act-shortcuts',
        icon: <Keyboard size={15} className="text-neutral-400" />,
        title: '查看快捷键',
        subtitle: 'Ctrl+/',
        keywords: 'shortcuts help 帮助',
        action: () => setShortcutsOpen(true),
      },
      {
        id: 'act-dashboard',
        icon: <BarChart3 size={15} className="text-emerald-400" />,
        title: '打开写作仪表盘',
        keywords: 'dashboard stats 统计 热力图 目标',
        action: () => setDashboardOpen(true),
      },
      {
        id: 'act-rhythm',
        icon: <Activity size={15} className="text-indigo-400" />,
        title: '查看剧情节奏图',
        keywords: 'rhythm 节奏 张力',
        action: () => setRhythmOpen(true),
      },
      {
        id: 'act-inspiration',
        icon: <Lightbulb size={15} className="text-amber-400" />,
        title: '打开灵感急救包',
        keywords: 'inspiration 灵感 卡文',
        action: () => setInspirationOpen(true),
      },
      {
        id: 'act-review',
        icon: <MessageSquareQuote size={15} className="text-orange-400" />,
        title: '打开 AI 批注评审',
        keywords: 'review 批注 审阅 编辑',
        action: () => window.dispatchEvent(new CustomEvent('inkbloom:show-review')),
      },
      {
        id: 'act-memory',
        icon: <Brain size={15} className="text-pink-400" />,
        title: '打开作品记忆面板',
        keywords: 'memory 人物卡 设定 前情',
        action: () => {
          setLeftTab('memory');
          useUIStore.getState().toggleLeft();
          if (useUIStore.getState().leftCollapsed) useUIStore.getState().toggleLeft();
        },
      },
      {
        id: 'act-outline',
        icon: <ListOrdered size={15} className="text-violet-400" />,
        title: '打开创作大纲面板',
        keywords: 'outline 大纲 幕 章节规划 扩写成稿 结构化创作',
        action: () => {
          setLeftTab('outline');
          if (useUIStore.getState().leftCollapsed) useUIStore.getState().toggleLeft();
        },
      },
      {
        id: 'role-novelist',
        icon: <BookMarked size={15} className="text-indigo-400" />,
        title: '切换到小说作者模式',
        keywords: 'role novelist 角色 小说',
        action: () => setRole('novelist'),
      },
      {
        id: 'role-media',
        icon: <Megaphone size={15} className="text-pink-400" />,
        title: '切换到自媒体作者模式',
        keywords: 'role media 角色 自媒体 分发',
        action: () => setRole('media'),
      },
      {
        id: 'role-memo',
        icon: <StickyNote size={15} className="text-amber-400" />,
        title: '切换到简约随记模式',
        keywords: 'role memo 角色 随记 笔记',
        action: () => setRole('memo'),
      },
    ];

    const novelItems: PaletteItem[] = novels.map((n) => ({
      id: `novel-${n.id}`,
      icon: <BookOpen size={15} className="text-indigo-400" />,
      title: n.title,
      subtitle: `作品 · ${n.word_count ?? 0} 字`,
      keywords: 'novel 小说 作品',
      action: () => selectNovel(n),
    }));

    const chapterItems: PaletteItem[] = chapters.map((c) => ({
      id: `chapter-${c.id}`,
      icon: <FileText size={15} className="text-emerald-400" />,
      title: c.title,
      subtitle: `章节 · ${c.word_count ?? 0} 字`,
      keywords: 'chapter 章节',
      action: () => selectChapter(c),
    }));

    const all = [...actions, ...novelItems, ...chapterItems];
    if (!q) return all;
    return all.filter(
      (item) =>
        item.title.toLowerCase().includes(q) || item.keywords?.toLowerCase().includes(q),
    );
  }, [query, novels, chapters, selectNovel, selectChapter, toggleFocusMode, toggleLeft, toggleRight, toggleAnalysis, setShortcutsOpen, setDashboardOpen, setRhythmOpen, setInspirationOpen, setRole, setLeftTab]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 激活项保持可见
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const execute = (item: PaletteItem) => {
    close();
    item.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[activeIndex]) execute(items[activeIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  if (!paletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" onMouseDown={close}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-fade-in" />
      <div
        className="relative glass-panel rounded-xl w-[560px] max-w-[90vw] animate-scale-in flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/8">
          <Search size={16} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索作品、章节或命令…"
            className="flex-1 bg-transparent text-sm text-neutral-100 placeholder-neutral-500 outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">
              没有匹配的结果
            </div>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => execute(item)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                i === activeIndex ? 'bg-brand-600/20' : ''
              }`}
            >
              <span className="shrink-0 w-7 h-7 rounded-md bg-white/5 flex items-center justify-center">
                {item.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-neutral-200 truncate">{item.title}</span>
              </span>
              {item.subtitle && (
                <span className="shrink-0 text-[11px] text-neutral-500">{item.subtitle}</span>
              )}
              {i === activeIndex && <CornerDownLeft size={13} className="text-neutral-500 shrink-0" />}
            </button>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/8 text-[11px] text-neutral-500">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 导航
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd> 执行
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
