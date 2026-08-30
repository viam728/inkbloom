import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Settings, List as ListIcon, MessageSquare } from 'lucide-react';
import type { PublicChapter, PublicChapterSummary } from '@/types/published';
import { useReaderStore } from '@/stores/reader-store';
import { useAuthStore } from '@/stores/auth-store';
import { useReaderInteractionStore } from '@/stores/reader-interaction-store';
import { upsertReadingProgress, createInteraction } from '@/services/reader-client';
import { track } from '@/services/analytics';
import { toast } from '@/components/common/Toast';
import ReaderSettings from './ReaderSettings';
import ReaderInteractions from './ReaderInteractions';

/** 情绪键映射（与后端 model.Mood* 一致），用于段落悬停情绪条 */
const MOODS: { key: string; emoji: string; label: string }[] = [
  { key: 'fire', emoji: '🔥', label: '燃' },
  { key: 'knife', emoji: '💔', label: '刀' },
  { key: 'sweet', emoji: '🍬', label: '甜' },
  { key: 'mystery', emoji: '❓', label: '谜' },
];

interface ChapterReaderProps {
  chapter: PublicChapter;
  chapters: PublicChapterSummary[];
  workId: number;
  slug: string;
  onNavigate: (pid: number) => void;
}

/**
 * 章节正文渲染 + 阅读进度上报（业务方案 v3 E4，施工任务 A19）
 *
 * 正文是服务端净化过的 HTML 片段，容器套 `tiptap` 类名复用编辑器的排版
 * 样式（index.css:147-250）。data-block-index 在渲染后由 useEffect 给
 * 顶层块级节点编号，供后续 A28 互动批注定位。
 *
 * 进度上报三时机：停止滚动 1s / 距上次 >10s 且位移 >0.02 / 页面隐藏。
 * 游客进度写 localStorage，登录态走 API（进度表按 user_id 唯一，匿名
 * 写不进去）。
 */
const ChapterReader: React.FC<ChapterReaderProps> = ({ chapter, chapters, workId, slug, onNavigate }) => {
  const { fontSize, lineHeight, theme, setSession } = useReaderStore();
  const status = useAuthStore((s) => s.status);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReportRef = useRef<{ pos: number; at: number }>({ pos: 0, at: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // 段落悬停情绪条（E5）
  const [hoverBlock, setHoverBlock] = useState<{ index: number; rect: DOMRect } | null>(null);
  // 选中划线评论（E5）
  const [selection, setSelection] = useState<{
    anchor: string;
    blockIndex: number;
    x: number;
    y: number;
  } | null>(null);

  // 主题色映射
  const themeClass = theme === 'sepia' ? 'reader-sepia' : theme === 'light' ? 'reader-light' : '';

  // 当前章节在目录中的位置，用于上下章导航
  const idx = chapters.findIndex((c) => c.id === chapter.id);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

  // 会话登记 + 埋点
  useEffect(() => {
    setSession(slug, chapter.id);
    track('read_chapter_view', { work_id: workId, chapter_id: chapter.id });
    // 进入章节时滚到顶部
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    lastReportRef.current = { pos: 0, at: Date.now() };
  }, [chapter.id, slug, workId, setSession]);

  // data-block-index：渲染后给顶层块级节点编号
  useEffect(() => {
    const container = scrollRef.current?.querySelector('.reader-body');
    if (!container) return;
    let i = 0;
    for (const child of Array.from(container.children)) {
      const tag = child.tagName.toLowerCase();
      if (['p', 'h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'pre'].includes(tag)) {
        child.setAttribute('data-block-index', String(i++));
      }
    }
  }, [chapter.id]);

  // 段落悬停：事件委托定位最近 data-block-index，供情绪条定位（E5）
  useEffect(() => {
    const container = scrollRef.current?.querySelector('.reader-body');
    if (!container) return;
    const onOver = (e: Event) => {
      const el = (e.target as HTMLElement).closest?.('[data-block-index]') as HTMLElement | null;
      if (el) {
        setHoverBlock({ index: Number(el.getAttribute('data-block-index')), rect: el.getBoundingClientRect() });
      } else {
        setHoverBlock(null);
      }
    };
    container.addEventListener('mouseover', onOver);
    return () => container.removeEventListener('mouseover', onOver);
  }, [chapter.id]);

  // 选中文本：浮出「划线评论」按钮（E5）
  useEffect(() => {
    const container = scrollRef.current?.querySelector('.reader-body');
    if (!container) return;
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const anchorEl = (node.nodeType === 1 ? (node as HTMLElement) : (node.parentElement as HTMLElement | null))
        ?.closest?.('[data-block-index]') as HTMLElement | null;
      if (!anchorEl) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelection({
        anchor: sel.toString().trim().slice(0, 500),
        blockIndex: Number(anchorEl.getAttribute('data-block-index')),
        x: rect.left,
        y: rect.top,
      });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [chapter.id]);

  // 情绪点击：一次点击记录段落情绪（E5）
  const recordMood = useCallback(
    async (blockIndex: number, mood: string) => {
      if (status !== 'authed') {
        toast.show('登录后即可参与情绪互动', 'info');
        return;
      }
      try {
        await createInteraction(chapter.id, {
          type: 'mood',
          block_index: blockIndex,
          payload: { mood },
        });
        track('interaction_created', { type: 'mood', chapter_id: chapter.id });
        useReaderInteractionStore.getState().bump();
      } catch (e) {
        toast.show(e instanceof Error ? e.message : '情绪提交失败', 'error');
      }
    },
    [chapter.id, status],
  );

  const openComment = useCallback(
    (blockIndex: number, anchor: string) => {
      useReaderInteractionStore.getState().openComposer({ block_index: blockIndex, anchor });
    },
    [],
  );

  // 进度计算与上报
  const reportProgress = useCallback(
    (force: boolean) => {
      const el = scrollRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      const pos = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
      const now = Date.now();
      const last = lastReportRef.current;
      const moved = Math.abs(pos - last.pos);
      // 节流：非强制时，需位移>0.02 或距上次>10s
      if (!force && moved < 0.02 && now - last.at < 10_000) return;
      last.at = now;
      last.pos = pos;

      if (status === 'authed') {
        upsertReadingProgress(workId, chapter.id, pos).catch(() => {
          /* 进度上报失败不影响阅读 */
        });
      } else {
        // 游客：写 localStorage，登录后可补报
        try {
          localStorage.setItem(
            `reader-progress:${workId}`,
            JSON.stringify({ chapter_id: chapter.id, position: pos }),
          );
        } catch {
          /* 忽略 */
        }
      }
    },
    [workId, chapter.id, status],
  );

  // 滚动节流（rAF + 150ms trailing）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        reportProgress(false);
        // 停止滚动 1s 后再报一次（捕获最终位置）
        if (stopTimer) clearTimeout(stopTimer);
        stopTimer = setTimeout(() => reportProgress(true), 1000);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (stopTimer) clearTimeout(stopTimer);
    };
  }, [reportProgress]);

  // 页面隐藏时立即上报
  useEffect(() => {
    const onHide = () => reportProgress(true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
    });
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [reportProgress]);

  const themeVars: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight: lineHeight,
  };

  return (
    <div className={`fixed inset-0 flex flex-col bg-surface-0 ${themeClass}`}>
      {/* 顶栏 */}
      <header className="shrink-0 flex items-center gap-3 px-4 h-12 border-b border-white/6 bg-surface-1/60">
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-white/8"
          title="目录"
        >
          <ListIcon size={16} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <h1 className="text-sm font-medium text-neutral-200 truncate">{chapter.title}</h1>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-white/8"
          title="阅读设置"
        >
          <Settings size={16} />
        </button>
      </header>

      {/* 目录抽屉 */}
      {navOpen && (
        <div className="absolute left-0 top-12 bottom-0 w-64 bg-surface-1 border-r border-white/6 overflow-y-auto z-20">
          <div className="p-2 space-y-0.5">
            {chapters.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setNavOpen(false);
                  onNavigate(c.id);
                }}
                className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                  c.id === chapter.id
                    ? 'bg-brand-600/20 text-brand-300'
                    : 'text-neutral-400 hover:bg-white/6 hover:text-neutral-200'
                }`}
              >
                {c.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 正文滚动区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <article
          className="reader-body tiptap mx-auto max-w-[680px] px-6 py-10 text-neutral-200"
          style={themeVars}
          dangerouslySetInnerHTML={{ __html: chapter.content }}
        />

        {/* 上下章导航 */}
        <nav className="mx-auto max-w-[680px] px-6 pb-16 flex items-center justify-between">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev.id)}
            className="flex items-center gap-1 px-3 py-2 rounded-md text-xs text-neutral-400 hover:bg-white/6 hover:text-neutral-200 disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronLeft size={14} /> 上一章
          </button>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && onNavigate(next.id)}
            className="flex items-center gap-1 px-3 py-2 rounded-md text-xs text-neutral-400 hover:bg-white/6 hover:text-neutral-200 disabled:opacity-30 disabled:pointer-events-none"
          >
            下一章 <ChevronRight size={14} />
          </button>
        </nav>
      </div>

      {settingsOpen && <ReaderSettings onClose={() => setSettingsOpen(false)} />}

      {/* 段落悬停情绪条（E5） */}
      {hoverBlock && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(hoverBlock.rect.right + 8, window.innerWidth - 200),
            top: Math.max(8, hoverBlock.rect.top + hoverBlock.rect.height / 2 - 18),
            zIndex: 45,
          }}
          onMouseLeave={() => setHoverBlock(null)}
          className="flex items-center gap-0.5 px-1.5 py-1 rounded-full bg-surface-1 border border-white/10 shadow-lg shadow-black/40"
        >
          {MOODS.map((m) => (
            <button
              key={m.key}
              type="button"
              title={`${m.label}`}
              onClick={() => void recordMood(hoverBlock.index, m.key)}
              className="w-7 h-7 flex items-center justify-center rounded-full text-sm hover:bg-white/10 transition-colors"
            >
              {m.emoji}
            </button>
          ))}
          <span className="w-px h-4 bg-white/10 mx-0.5" />
          <button
            type="button"
            title="评论此段"
            onClick={() => openComment(hoverBlock.index, '')}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-300 hover:bg-white/10 transition-colors"
          >
            <MessageSquare size={14} />
          </button>
        </div>
      )}

      {/* 选中划线评论按钮（E5） */}
      {selection && (
        <button
          type="button"
          onClick={() => {
            openComment(selection.blockIndex, selection.anchor);
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
          style={{
            position: 'fixed',
            left: Math.min(selection.x, window.innerWidth - 120),
            top: Math.max(8, selection.y - 34),
            zIndex: 45,
          }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-brand-600 hover:bg-brand-500 text-white text-xs shadow-lg shadow-black/40"
        >
          <MessageSquare size={12} /> 划线评论
        </button>
      )}

      <ReaderInteractions chapterId={chapter.id} />
    </div>
  );
};

export default ChapterReader;
