import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PenLine,
  Check,
  CloudUpload,
  AlertCircle,
  X,
  Home,
  Wand2,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useEditorStore } from '@/stores/editor-store';
import { useUIStore } from '@/stores/ui-store';
import { useStatsStore } from '@/stores/stats-store';
import { useTabStore, countDraftWords, chapterTabKey, STORY_TAB_KEY, type EditorTab } from '@/stores/tab-store';
import { useOutlineStore, type OutlineNode } from '@/stores/outline-store';
import { useChapterDraft } from '@/hooks/useChapterDraft';
import { putAutoSnapshot } from '@/utils/temp-branch';
import { toast } from '@/components/common/Toast';
import { saveDraft, loadDraft } from '@/utils/draft-vault';
import TipTapEditor from './TipTapEditor';
import NovelOverview from './NovelOverview';
import AigcCard from '@/components/ai/AigcCard';
import type { AigcClueContext } from '@/components/ai/AigcCard';
import StoryWorkflowPanel from '@/components/story/StoryWorkflowPanel';
import OutlineNodeEditor from '@/components/outline/OutlineNodeEditor';
import DraftPreviewModal from '@/components/outline/DraftPreviewModal';
import MemoryEditorPanel from '@/components/memory/MemoryEditorPanel';
import Kbd from '@/components/common/Kbd';
import ForeshadowHintBar from '@/components/knowledge/ForeshadowHintBar';

/** 正文自动保存防抖（per-tab 独立计时）。备忘录 L29：浏览器快存（1s 本地
 *  draft-vault）+ 服务器提交降频（15s）；切章 / 关标签页 / 页面隐藏立即 flush，
 *  崩溃丢失窗口 = 15s，且有浏览器快存兜底。 */
const SAVE_DEBOUNCE_MS = 15000;
/** 标题重命名防抖 */
const TITLE_DEBOUNCE_MS = 500;

const EditorArea: React.FC = () => {
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const focusMode = useUIStore((s) => s.focusMode);
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  // F2-4：保存重试耗尽后的常驻横幅开关
  const offlineUnsaved = useEditorStore((s) => s.offlineUnsaved);

  // 写作统计：正增长计入当日仪表盘（以各 tab 自身 wordCount 为基线）
  const addWords = useStatsStore((s) => s.addWords);

  /** 每 tab 独立的保存防抖计时器 */
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** flush 指定 tab：清除计时器，若脏则立即以当前草稿落盘（仅章节 tab 有落盘语义） */
  const flushTab = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(key);
    }
    const tab = useTabStore.getState().tabs.find((t) => t.key === key);
    // loadError（F2-8）：内容可能不完整，禁止把不完整草稿覆盖到服务器
    if (
      tab?.kind === 'chapter' &&
      tab.chapterId != null &&
      tab.isDirty &&
      !tab.loadError &&
      tab.saveStatus !== 'saving'
    ) {
      void useEditorStore.getState().saveChapter(tab.chapterId, tab.draft);
    }
  }, []);

  // ── 手动保存兜底（备忘录 L61）：拦截浏览器全局 Ctrl+S / Cmd+S ─────────
  // 默认行为是"保存网页 HTML"，毫无用处且危险（会把单页应用外壳存下来）。
  // 拦截后映射为「保存当前激活章节 tab」：与防抖 flush 同一链路（清计时器 +
  // 脏则立即落盘），保存状态由底部状态栏展示。capture 阶段注册，保证先于
  // 任何子组件与浏览器默认行为；无激活章节 tab 时仅吞掉快捷键。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        const st = useTabStore.getState();
        if (st.activeKey) flushTab(st.activeKey);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [flushTab]);

  // ── AI 成章（正文编辑入口，备忘录 L61）───────────────────────────────
  // 编辑器顶部统一 AIGC 配置卡（scene=chapter）派发成章：按当前章节绑定的
  // 大纲要点走成章管线生成整章正文 → 预览确认后覆盖编辑版本（走既有防抖落盘链路）。
  // 任务通知由 useChapterDraft 登记本地伪任务（chapter_generate），卡片走宿主管线不重复登记。
  const {
    draft: composeDraft,
    memoryRefs: composeRefs,
    generating: composeGenerating,
    generate: generateChapter,
    reset: resetCompose,
  } = useChapterDraft();
  const [composeTarget, setComposeTarget] = useState<{ chapterId: number; title: string; prevDraft: string } | null>(null);

  const runCompose = useCallback(
    async (extra?: string, ctx?: AigcClueContext) => {
      if (!currentNovel || !currentChapter) return;
      const st = useTabStore.getState();
      const tab = st.tabs.find((t) => t.key === chapterTabKey(currentChapter.id));
      if (tab?.kind !== 'chapter' || tab.loadError) {
        toast.show('当前正文尚未完整加载，暂不能成章覆盖', 'error');
        return;
      }
      setComposeTarget({
        chapterId: currentChapter.id,
        title: currentChapter.title,
        prevDraft: tab.draft ?? '',
      });
      const acts = useOutlineStore.getState().byNovel[currentNovel.id] ?? [];
      let node: OutlineNode | undefined;
      for (const act of acts) {
        node = act.nodes.find((n) => n.chapter_id === currentChapter.id);
        if (node) break;
      }
      const base = node
        ? '请基于该要点的标题与梗概、它在大纲中的位置、前文与既有设定，撰写本章完整正文。'
        : '该章节暂无绑定大纲要点，请依据全书大纲、前文与既有设定续写本章完整正文。';
      await generateChapter(currentNovel.id, {
        nodeId: node?.id,
        instruction: extra ? `${base}\n附加要求：${extra}` : base,
        // AIGC 卡上下文开关（架构/本章/附近已在指令块中；大纲/记忆/悬念走服务端开关）
        context: ctx
          ? {
              outline: ctx.selected.includes('outline'),
              memory: ctx.selected.includes('memory'),
              foreshadow: ctx.selected.includes('foreshadow'),
            }
          : undefined,
      });
    },
    [currentNovel, currentChapter, generateChapter],
  );

  useEffect(() => {
    const onCompose = () => void runCompose();
    window.addEventListener('inkbloom:ai-compose', onCompose);
    return () => window.removeEventListener('inkbloom:ai-compose', onCompose);
  }, [runCompose]);

  const handleComposeWrite = useCallback(() => {
    if (!composeTarget || !composeDraft) return;
    const key = chapterTabKey(composeTarget.chapterId);
    const st = useTabStore.getState();
    // AI 全篇覆盖前：把覆盖前的正文存入工作区自动快照（浏览器本地，可撤销）
    if (composeTarget.prevDraft.trim()) {
      putAutoSnapshot(composeTarget.chapterId, composeTarget.prevDraft, 'AI 成章覆盖前');
    }
    st.updateTab(key, {
      draft: composeDraft,
      isDirty: true,
      wordCount: countDraftWords(composeDraft),
    });
    saveDraft(key, composeDraft);
    void useEditorStore.getState().saveChapter(composeTarget.chapterId, composeDraft);
    toast.show('AI 成章已写入当前正文（覆盖前正文已存入工作区快照）', 'success');
    setComposeTarget(null);
    resetCompose();
  }, [composeTarget, composeDraft, resetCompose]);

  // 兜底：currentChapter 被 selectChapter 之外的路径改写（如 OutlinePanel 直写初稿）
  // 时补开/激活 tab，并回填异步到达的内容与列表侧重命名
  useEffect(() => {
    if (!currentChapter) return;
    const st = useTabStore.getState();
    const existing = st.tabs.find((t) => t.chapterId === currentChapter.id);
    if (!existing) {
      st.openTab(currentChapter.id, currentChapter.title, currentChapter.content || '');
      // 本地兜底恢复（F2-3）：vault 中存在该章遗留草稿 = 上次保存未成功，
      // 优先于服务器内容，避免防抖窗口内刷新/断网导致最后输入丢失。
      const key = chapterTabKey(currentChapter.id);
      const saved = loadDraft(key);
      if (saved != null && saved !== (currentChapter.content || '')) {
        st.updateTab(key, { draft: saved, isDirty: true, wordCount: countDraftWords(saved) });
      }
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

  // active tab → editor-store 镜像（ReviewPanel 等既有消费者仍读镜像；panel 类 tab 无章节语义，清空镜像）
  useEffect(() => {
    useEditorStore.getState().mirrorTab(activeTab && activeTab.kind === 'chapter' ? activeTab : null);
  }, [activeTab]);

  // 中央起稿窗口：概览页「AI 起稿」按钮 / 作品列表入口派发此事件 → 打开可关闭的 story Home tab
  useEffect(() => {
    const openStory = () =>
      useTabStore
        .getState()
        .openPanelTab(STORY_TAB_KEY, 'AI 起稿', 'story', {});
    window.addEventListener('inkbloom:open-story-workflow', openStory);
    return () => window.removeEventListener('inkbloom:open-story-workflow', openStory);
  }, []);

  // 内容变化 → 回写 active tab 草稿并重置该 tab 的防抖计时
  const handleChange = useCallback((html: string) => {
    const st = useTabStore.getState();
    const key = st.activeKey;
    if (!key) return;
    st.updateTab(key, { draft: html, isDirty: true });
    // 本地兜底同步写（F2-3）：1s 节流，保存成功后由 saveChapter 清除
    saveDraft(key, html);
    const prev = timersRef.current.get(key);
    if (prev) clearTimeout(prev);
    timersRef.current.set(
      key,
      setTimeout(() => {
        timersRef.current.delete(key);
        const tab = useTabStore.getState().tabs.find((t) => t.key === key);
        if (
          tab?.kind === 'chapter' &&
          tab.chapterId != null &&
          tab.isDirty &&
          !tab.loadError &&
          tab.saveStatus !== 'saving'
        ) {
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

  /**
   * 激活 overview 首页 tab 时联动选中对应作品（点击当前书 → 首页语义）。
   * 返回 true 表示已接管激活（异步 selectNovel 完成后再 setActive），调用方应提前 return。
   */
  const syncNovelForOverview = useCallback((tab: EditorTab): boolean => {
    if (tab.kind !== 'overview') return false;
    const novelId = tab.meta?.novelId;
    if (novelId == null) return false;
    const ns = useNovelStore.getState();
    if (ns.currentNovel?.id === novelId) return false;
    const novel = ns.novels.find((n) => n.id === novelId);
    if (!novel) return false;
    void ns.selectNovel(novel).then(() => useTabStore.getState().setActive(tab.key));
    return true;
  }, []);

  /** 切换 tab：章节 tab 先 flush 并经 selectChapter 同步 currentChapter；panel 类 tab 仅激活 */
  const handleSwitch = useCallback(
    (key: string) => {
      const st = useTabStore.getState();
      if (st.activeKey === key) return;
      if (st.activeKey) flushTab(st.activeKey);
      const tab = st.tabs.find((t) => t.key === key);
      if (!tab) return;
      // 全书首页 tab：激活时联动选中对应作品
      if (syncNovelForOverview(tab)) return;
      if (tab.kind !== 'chapter' || tab.chapterId == null) {
        st.setActive(key);
        return;
      }
      const chapter = useNovelStore.getState().chapters.find((c) => c.id === tab.chapterId);
      if (chapter) void useNovelStore.getState().selectChapter(chapter);
      else st.setActive(key);
    },
    [flushTab, syncNovelForOverview],
  );

  /** 关闭 tab：章节 tab flush 并让 currentChapter 跟随新激活项；panel 类 tab 直接关闭 */
  const handleClose = useCallback(
    (key: string) => {
      flushTab(key);
      const st = useTabStore.getState();
      const wasActive = st.activeKey === key;
      st.closeTab(key);
      if (!wasActive) return;
      const nst = useTabStore.getState();
      const next = nst.tabs.find((t) => t.key === nst.activeKey);
      if (!next) {
        useNovelStore.setState({ currentChapter: null });
        return;
      }
      // 关闭后露出的首页 tab：同样联动选书
      if (syncNovelForOverview(next)) return;
      // panel 类 tab 激活时保持 currentChapter 不动（回到章节 tab 时再同步）
      if (next.kind !== 'chapter' || next.chapterId == null) return;
      const chapter = useNovelStore.getState().chapters.find((c) => c.id === next.chapterId);
      if (chapter) void useNovelStore.getState().selectChapter(chapter);
    },
    [flushTab, syncNovelForOverview],
  );

  // 组件卸载：flush 全部未落盘计时器
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const key of Array.from(timers.keys())) flushTab(key);
    };
  }, [flushTab]);

  // 服务器降频（15s）的兜底 flush：页面隐藏 / 编辑器失焦时立即落盘，
  // 把「变动即存浏览器 + 降频提交服务器」的丢失窗口压到最小。
  useEffect(() => {
    const flushAllNow = () => {
      const st = useTabStore.getState();
      if (st.activeKey) flushTab(st.activeKey);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flushAllNow();
    };
    window.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', flushAllNow);
    return () => {
      window.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', flushAllNow);
    };
  }, [flushTab]);

  // ── 章节标题（下移至工具栏下方，可编辑）──────────────────────────────
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 提交标题：tab-store + novel-store（章节列表/currentChapter）三处一致（仅章节 tab）；
   *  并反向同步大纲要点标题（要点 ↔ 章节标题双向一致） */
  const commitTitle = useCallback((value: string) => {
    const st = useTabStore.getState();
    const tab = st.tabs.find((t) => t.key === st.activeKey);
    const title = value.trim();
    if (!tab || tab.kind !== 'chapter' || tab.chapterId == null || !title || title === tab.title) return;
    st.renameTab(tab.key, title);
    const novelId = useNovelStore.getState().currentNovel?.id;
    void useNovelStore.getState().renameChapter(tab.chapterId, title).catch(() => undefined);
    // 反向同步：找到绑定该章节的大纲要点，要点标题跟随章节标题
    if (novelId != null) {
      const acts = useOutlineStore.getState().byNovel[novelId];
      for (const act of acts ?? []) {
        const bound = act.nodes.find((n) => n.chapter_id === tab.chapterId);
        if (bound && bound.title !== title) {
          useOutlineStore.getState().updateNode(novelId, act.id, bound.id, { title });
        }
      }
    }
  }, []);

  const handleTitleChange = (value: string) => {
    setTitleDraft(value);
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      commitTitle(value);
    }, TITLE_DEBOUNCE_MS);
  };

  const titleSlot =
    activeTab && activeTab.kind === 'chapter' ? (
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

  // 正文编辑 AIGC 配置卡（备忘录 L61）：置于编辑工具列表顶部，成章走宿主
  // 预览管线（DraftPreviewModal 确认后覆盖），任务通知由 useChapterDraft 登记
  const chapterAigcSlot =
    activeTab && activeTab.kind === 'chapter' && currentNovel ? (
      <AigcCard
        novelId={currentNovel.id}
        scene="chapter"
        taskLabel="AIGC · AI 成章"
        hint="按大纲要点与全书上下文生成本章正文，预览确认后覆盖编辑版本"
        buildInstruction={(extra) => extra}
        onGenerate={(instruction, ctx) => void runCompose(instruction, ctx)}
        running={composeGenerating}
      />
    ) : undefined;

  // 无任何 tab 时显示欢迎页；全书首页 / AI 起稿已改为可关闭的 Home tab
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
      {/* 主动提示条（业务方案 v3 A15）：无提示时返回 null，不占版面 */}
      <ForeshadowHintBar />
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
                {/* Home 类 tab（全书首页 / AI 起稿）图标区分 */}
                {tab.kind === 'overview' && <Home size={11} className="shrink-0 text-brand-300" />}
                {tab.kind === 'story' && <Wand2 size={11} className="shrink-0 text-violet-300" />}
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

      {/* 编辑器 / 中央面板：章节 tab 走单实例 TipTap；panel 类 tab 常驻挂载（hidden 切换）保留编辑状态 */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab.kind === 'chapter' && (
          <>
            {/* F2-8：正文加载失败警示 —— 内容可能不完整，动笔会覆盖正文 */}
            {activeTab.loadError && (
              <div className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
                <span>章节内容加载失败，当前展示可能不完整。请先重试加载，确认完整后再编辑。</span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 text-amber-200 hover:bg-amber-400/10"
                  onClick={() => {
                    const chapter = useNovelStore.getState().chapters.find(
                      (c) => c.id === activeTab.chapterId,
                    );
                    if (chapter) void useNovelStore.getState().selectChapter(chapter);
                  }}
                >
                  重新加载
                </button>
              </div>
            )}
            {/* F2-4：保存连续失败且自动重试耗尽后的常驻横幅 */}
            {offlineUnsaved && (
              <div className="flex items-center justify-between gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <span>内容尚未保存到云端（已暂存本地），请检查网络后重试。</span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-red-400/40 px-2 py-0.5 text-red-200 hover:bg-red-400/10"
                  onClick={() => useEditorStore.getState().retryFailedSaves()}
                >
                  立即重试
                </button>
              </div>
            )}
            <TipTapEditor
              key={activeTab.key}
              content={activeTab.draft}
              onChange={handleChange}
              onWordCount={handleWordCount}
              titleSlot={titleSlot}
              aigcSlot={chapterAigcSlot}
            />
          </>
        )}
        {tabs
          .filter((t) => t.kind !== 'chapter')
          .map((t) => (
            <div
              key={t.key}
              className={t.key === activeKey ? 'absolute inset-0 flex flex-col bg-surface-0' : 'hidden'}
            >
              {t.kind === 'outline-node' && t.meta?.actId && t.meta?.nodeId ? (
                <OutlineNodeEditor tabKey={t.key} actId={t.meta.actId} nodeId={t.meta.nodeId} />
              ) : t.kind === 'memory' ? (
                <MemoryEditorPanel tabKey={t.key} meta={t.meta ?? {}} />
              ) : t.kind === 'overview' && t.meta?.novelId != null ? (
                <NovelOverview novelId={t.meta.novelId} />
              ) : t.kind === 'story' ? (
                <StoryWorkflowPanel tabKey={t.key} />
              ) : null}
            </div>
          ))}
      </div>

      {/* 底部状态栏：字数 / 阅读耗时 / 保存状态（仅章节编辑 tab；平台快链已收纳进导出弹窗） */}
      {activeTab.kind === 'chapter' && (
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
      )}

      {/* AI 成章初稿预览：确认后覆盖当前章节编辑版本 */}
      <DraftPreviewModal
        open={composeTarget !== null}
        title={composeTarget?.title || ''}
        draft={composeGenerating ? null : composeDraft}
        memoryRefs={composeRefs}
        writing={false}
        writeLabel="覆盖当前正文"
        onClose={() => {
          setComposeTarget(null);
          resetCompose();
        }}
        onWrite={handleComposeWrite}
      />
    </div>
  );
};

export default EditorArea;

