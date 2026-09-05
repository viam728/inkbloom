import React, { useMemo } from 'react';
import {
  BookOpen,
  FileText,
  Focus,
  PanelLeft,
  PanelRight,
  ImagePlus,
  Keyboard,
  BarChart3,
  Activity,
  Lightbulb,
  MessageSquareQuote,
  Brain,
  ListOrdered,
  BookMarked,
  Megaphone,
  StickyNote,
  Images,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import { useTabStore, overviewTabKey } from '@/stores/tab-store';

export interface PaletteItem {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  keywords?: string;
  action: () => void;
}

/**
 * 命令/跳转项构建 hook：CommandPalette（Ctrl+K 全屏面板）与
 * TopBar 居中搜索共用同一份 items 来源，保证行为一致。
 * @param query 过滤关键词（空串返回全量）
 */
export function useCommandItems(query: string): PaletteItem[] {
  const toggleFocusMode = useUIStore((s) => s.toggleFocusMode);
  const toggleLeft = useUIStore((s) => s.toggleLeft);
  const toggleRight = useUIStore((s) => s.toggleRight);
  const toggleAnalysis = useUIStore((s) => s.toggleAnalysis);
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
  const setDashboardOpen = useUIStore((s) => s.setDashboardOpen);
  const setInspirationOpen = useUIStore((s) => s.setInspirationOpen);
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab);
  const setRole = useUIStore((s) => s.setRole);
  const setLeftTab = useUIStore((s) => s.setLeftTab);

  const { novels, chapters, selectNovel, selectChapter } = useNovelStore();

  return useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();

    /** 洞察三件套入口：右侧板「洞察」Tab 深链；随记模式无右侧板，保留仪表盘/灵感包弹窗 */
    const openInsight = (view: 'rhythm' | 'dashboard' | 'inspiration') => {
      if (useUIStore.getState().role === 'memo') {
        if (view === 'dashboard') setDashboardOpen(true);
        if (view === 'inspiration') setInspirationOpen(true);
        return;
      }
      useUIStore.getState().setInsightView(view);
      setActiveRightTab('insight');
      if (useUIStore.getState().rightCollapsed) toggleRight();
    };

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
        action: () => openInsight('dashboard'),
      },
      {
        id: 'act-rhythm',
        icon: <Activity size={15} className="text-indigo-400" />,
        title: '查看剧情节奏图',
        keywords: 'rhythm 节奏 张力',
        action: () => openInsight('rhythm'),
      },
      {
        id: 'act-inspiration',
        icon: <Lightbulb size={15} className="text-amber-400" />,
        title: '打开灵感急救包',
        keywords: 'inspiration 灵感 卡文',
        action: () => openInsight('inspiration'),
      },
      {
        id: 'act-gallery',
        icon: <Images size={15} className="text-teal-400" />,
        title: '打开图床资源管理',
        keywords: 'gallery image 图床 图片 素材 上传',
        action: () => {
          setActiveRightTab('gallery');
          if (useUIStore.getState().rightCollapsed) toggleRight();
        },
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
      action: () => {
        selectNovel(n);
        // 全书首页 = 可关闭 Home tab
        useTabStore.getState().openPanelTab(overviewTabKey(n.id), n.title, 'overview', { novelId: n.id });
      },
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
  }, [query, novels, chapters, selectNovel, selectChapter, toggleFocusMode, toggleLeft, toggleRight, toggleAnalysis, setShortcutsOpen, setDashboardOpen, setInspirationOpen, setActiveRightTab, setRole, setLeftTab]);
}
