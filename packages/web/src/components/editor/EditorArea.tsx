import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PenLine,
  Check,
  CloudUpload,
  AlertCircle,
  X,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useEditorStore } from '@/stores/editor-store';
import { useUIStore } from '@/stores/ui-store';
import { useStatsStore } from '@/stores/stats-store';
import { useTabStore, countDraftWords } from '@/stores/tab-store';
import TipTapEditor from './TipTapEditor';
import Kbd from '@/components/common/Kbd';

/** 正文自动保存防抖（per-tab 独立计时） */
const SAVE_DEBOUNCE_MS = 2000;
/** 标题重命名防抖 */
const TITLE_DEBOUNCE_MS = 500;

const EditorArea: React.FC = () => {
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const focusMode = useUIStore((s) => s.focusMode);
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;

  // 写作统计：正增长计入当日仪表盘（以各 tab 自身 wordCount 为基线）
  const addWords = useStatsStore((s) => s.addWords);

  /** 每 tab 独立的保存防抖计时器 */
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** flush 指定 tab：清除计时器，若脏则立即以当前草稿落盘 */
  const flushTab = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(key);
    }
    const tab = useTabStore.getState().tabs.find((t) => t.key === key);
    if (tab?.isDirty && tab.saveStatus !== 'saving') {
      void useEditorStore.getState().saveChapter(tab.chapterId, tab.draft);
    }
  }, []);

  // 兜底：currentChapter 被 selectChapter 之外的路径改写（如 OutlinePanel 直写初稿）
  // 时补开/激活 tab，并回填异步到达的内容与列表侧重命名
  useEffect(() => {
    if (!currentChapter) return;
    const st = useTabStore.getState();
    const existing = st.tabs.find((t) => t.chapterId === currentChapter.id);
    if (!existing) {
      st.openTab(currentChapter.id, currentChapter.title, currentChapter.content || '');
      return;
    }
    if (st.activeKey !== existing.key) st.setActive(existing.key);
    if (existing.title !== currentChapter.title) st.renameTab(existing.key, currentChapter.title);
    // 内容滞后到达：tab 尚无草稿且用户未编辑时回填（避免覆盖在编内容）
    if (!existing.isDirty && !existing.draft && currentChapter.content) {
      st.updateTab(existing.key, {
        draft: currentChapter.content,
        wordCount: countDraftWords(currentChapter.content),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.id, currentChapter?.title, currentChapter?.content]);

  // active tab → editor-store 镜像（ReviewPanel 等既有消费者仍读镜像）
  useEffect(() => {
    useEditorStore.getState().mirrorTab(activeTab);
  }, [activeTab]);

  // 内容变化 → 回写 active tab 草稿并重置该 tab 的防抖计时
  const handleChange = useCallback((html: string) => {
    const st = useTabStore.getState();
    const key = st.activeKey;
    if (!key) return;
    st.updateTab(key, { draft: html, isDirty: true });
    const prev = timersRef.current.get(key);
    if (prev) clearTimeout(prev);
    timersRef.current.set(
      key,
      setTimeout(() => {
        timersRef.current.delete(key);
        const tab = useTabStore.getState().tabs.find((t) => t.key === key);
        if (tab?.isDirty && tab.saveStatus !== 'saving') {
          void useEditorStore.getState().saveChapter(tab.chapterId, tab.draft);
        }
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);

  // 字数回调：增量统计以 active tab 的 wordCount 为基线，切换章节不会把全文计为新增
  const handleWordCount = useCallback(
    (count: number) => {
      const st = useTabStore.getState();
      const key = st.activeKey;
      if (!key) return;
      const tab = st.tabs.find((t) => t.key === key);
      const delta = count - (tab?.wordCount ?? count);
      if (delta > 0) addWords(delta);
      st.updateTab(key, { wordCount: count });
    },
    [addWords],
  );

  /** 切换 tab：先 flush 旧 tab 未落盘内容，再经 selectChapter 同步 currentChapter（已打开 tab 不重拉内容） */
  const handleSwitch = useCallback(
    (key: string) => {
      const st = useTabStore.getState();
      if (st.activeKey === key) return;
      if (st.activeKey) flushTab(st.activeKey);
      const tab = st.tabs.find((t) => t.key === key);
      if (!tab) return;
      const chapter = useNovelStore.getState().chapters.find((c) => c.id === tab.chapterId);
      if (chapter) void useNovelStore.getState().selectChapter(chapter);
      else st.setActive(key);
    },
    [flushTab],
  );

  /** 关闭 tab：先 flush（调用方约定），关闭 active 后 currentChapter 跟随新激活项 */
  const handleClose = useCallback(
    (key: string) => {
      flushTab(key);
      const st = useTabStore.getState();
      const wasActive = st.activeKey === key;
      st.closeTab(key);
      if (!wasActive) return;
      const nst = useTabStore.getState();
      const next = nst.tabs.find((t) => t.key === nst.activeKey);
      const chapter = next
        ? useNovelStore.getState().chapters.find((c) => c.id === next.chapterId)
        : undefined;
      if (chapter) void useNovelStore.getState().selectChapter(chapter);
      else useNovelStore.setState({ currentChapter: null });
    },
    [flushTab],
  );

  // 组件卸载：flush 全部未落盘计时器
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const key of Array.from(timers.keys())) flushTab(key);
    };
  }, [flushTab]);

  // ── 章节标题（下移至工具栏下方，可编辑）──────────────────────────────
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 提交标题：tab-store + novel-store（章节列表/currentChapter）三处一致 */
  const commitTitle = useCallback((value: string) => {
    const st = useTabStore.getState();
    const tab = st.tabs.find((t) => t.key === st.activeKey);
    const title = value.trim();
    if (!tab || !title || title === tab.title) return;
    st.renameTab(tab.key, title);
    void useNovelStore.getState().renameChapter(tab.chapterId, title).catch(() => undefined);
  }, []);

  const handleTitleChange = (value: string) => {
    setTitleDraft(value);
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      commitTitle(value);
    }, TITLE_DEBOUNCE_MS);
  };

  const titleSlot = activeTab ? (
    <div className="shrink-0 px-8 pt-4 pb-2 border-b border-white/4 bg-surface-0">
      <input
        type="text"
        value={titleEditing ? titleDraft : activeTab.title}
        onFocus={() => {
          setTitleDraft(activeTab.title);
          setTitleEditing(true);
        }}
        onBlur={() => {
          if (titleTimerRef.current) {
            clearTimeout(titleTimerRef.current);
            titleTimerRef.current = null;
          }
          commitTitle(titleDraft);
          setTitleEditing(false);
        }}
        onChange={(e) => handleTitleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        placeholder="未命名章节"
        aria-label="章节标题"
        className="w-full bg-transparent text-xl font-semibold tracking-tight text-neutral-100 placeholder-neutral-600 outline-none"
      />
    </div>
  ) : undefined;

  // 欢迎页（无任何打开的 tab）
  if (!activeTab) {
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
  const readingMinutes = Math.max(1, Math.round(activeTab.wordCount / 500));

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

  const status = activeTab.isDirty && activeTab.saveStatus === 'idle'
    ? { icon: <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-soft" />, label: '未保存', className: 'text-amber-400' }
    : saveStatusConfig[activeTab.saveStatus];

  return (
    <div className={`flex-1 flex flex-col min-w-0 bg-surface-0 ${focusMode ? 'focus-mode' : ''}`}>
      {/* 编辑板 TabBar（原章节标题位置）：点击切换 / × 或中键关闭，关闭前 flush 保存 */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 px-2 h-9 shrink-0 border-b border-white/6 bg-surface-1/50 overflow-x-auto select-none">
          {tabs.map((tab) => {
            const active = tab.key === activeKey;
            const showSaving = tab.saveStatus === 'saving';
            return (
              <div
                key={tab.key}
                onClick={() => handleSwitch(tab.key)}
                onMouseDown={(e) => {
                  // 中键关闭
                  if (e.button === 1) {
                    e.preventDefault();
                    handleClose(tab.key);
                  }
                }}
                title={tab.title}
                className={`group/tab relative flex items-center gap-1.5 h-7 pl-3 pr-1.5 rounded-md text-xs cursor-pointer transition-colors max-w-[180px] shrink-0 ${
                  active
                    ? 'bg-surface-0 text-neutral-100'
                    : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-300'
                }`}
              >
                {active && (
                  <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-indigo-400 to-pink-400 pointer-events-none" />
                )}
                <span className="truncate">{tab.title}</span>
                <span className="relative shrink-0 w-4 h-4 flex items-center justify-center">
                  {showSaving ? (
                    <CloudUpload size={11} className="text-amber-400 animate-pulse-soft" />
                  ) : (
                    tab.isDirty && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 group-hover/tab:hidden" />
                    )
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClose(tab.key);
                    }}
                    title="关闭编辑板（先保存未落盘内容）"
                    className={`${active ? 'flex' : 'hidden'} group-hover/tab:flex items-center justify-center w-4 h-4 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors`}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 编辑器：单实例不重建，切 tab 经 content 换绑；标题下移至工具栏下方 */}
      <div className="flex-1 overflow-hidden relative">
        <TipTapEditor
          content={activeTab.draft}
          onChange={handleChange}
          onWordCount={handleWordCount}
          titleSlot={titleSlot}
        />
      </div>

      {/* 底部状态栏：字数 / 阅读耗时 / 保存状态（平台快链已收纳进导出弹窗） */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-white/6 bg-surface-1/60 text-xs text-neutral-500">
        <div className="flex items-center gap-3">
          <span className="tabular-nums">{activeTab.wordCount.toLocaleString()} 字</span>
          <span className="text-neutral-700">|</span>
          <span className="tabular-nums">约 {readingMinutes} 分钟阅读</span>
        </div>
        {status.icon && (
          <span className={`flex items-center gap-1.5 ${status.className} animate-fade-in`}>
            {status.icon}
            {status.label}
          </span>
        )}
      </div>
    </div>
  );
};

export default EditorArea;
