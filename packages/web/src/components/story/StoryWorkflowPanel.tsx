import React, { useEffect, useRef, useState } from 'react';
import { Wand2, Play, ArrowRight, Check, Trash2, Loader2, ChevronDown, ChevronUp, RefreshCw, PenLine } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useStoryStore, STAGE_ORDER } from '@/stores/story-store';
import { useUIStore } from '@/stores/ui-store';
import { STORY_STAGE_LABELS } from '@/services/story-client';
import type { StoryJob } from '@/services/story-client';
import { suggestStoryTitle } from '@/services/ai-actions-client';
import { toast } from '@/components/common/Toast';

/**
 * Agent 全本创作工作流面板。
 *
 * 从一句话创意出发，驱动 story_jobs 状态机逐步生成：
 *   创意 → 大纲 → 分章 → 成稿（逐章预览/采纳）→ 校验 → 定稿。
 * AI 产物先进 stage_payload（预览态），作者点「采纳」才写入真实章节。
 */
const StoryWorkflowPanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const createNovel = useNovelStore((s) => s.createNovel);
  const selectNovel = useNovelStore((s) => s.selectNovel);
  const updateNovel = useNovelStore((s) => s.updateNovel);
  const {
    jobs,
    activeJob,
    loading,
    generating,
    adopting,
    loadJobs,
    openJob,
    closeJob,
    createJob,
    generateStage,
    advanceStage,
    jumpStage,
    adoptChapter,
    removeJob,
    refreshActive,
  } = useStoryStore();

  const [title, setTitle] = useState('');
  const [logline, setLogline] = useState('');
  const [expandedContent, setExpandedContent] = useState(false);
  // 生成设置（缺陷4：动态滑条，AI 按设置填充系统）
  const [chapterCount, setChapterCount] = useState(10);
  const [wordsPerChapter, setWordsPerChapter] = useState(2000);
  const [style, setStyle] = useState('');
  // 创作意图栏（C9）：定受众/意图，决定叙事取向与语感
  const [audience, setAudience] = useState('');
  const [intent, setIntent] = useState('');
  const [autoSettle, setAutoSettle] = useState(true);
  // AI 填写书名：候选列表 + 生成中态
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([]);
  const [aiFilling, setAiFilling] = useState(false);
  // 滑动选择器：拖动中的节点索引（仅用于标签高亮），以及连续指针比例（手柄实际跟随）
  const [dragStageIdx, setDragStageIdx] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // 简介（迁自概览页）：创建/编辑作品信息用，随当前作品预填
  const [description, setDescription] = useState('');
  useEffect(() => {
    setDescription(currentNovel?.description ?? '');
  }, [currentNovel?.id, currentNovel?.description]);
  // 选中作品时书名随当前作品预填（可手动更改）
  useEffect(() => {
    if (currentNovel?.id) setTitle(currentNovel.title);
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 加载当前作品的任务
  useEffect(() => {
    if (currentNovel?.id) loadJobs(currentNovel.id);
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    const log = logline.trim();
    if (!log) {
      toast.show('请填写一句话创意', 'error');
      return;
    }
    // 已选定作品：书名取编辑框（默认本作标题，可改），简介有改动则同步保存
    if (currentNovel?.id) {
      try {
        const t = title.trim() || currentNovel.title;
        if ((description.trim() ?? '') !== (currentNovel.description ?? '')) {
          await updateNovel(currentNovel.id, { description: description.trim() });
        }
        const job = await createJob({
          novel_id: currentNovel.id,
          title: t,
          logline: log,
          config: { chapter_count: chapterCount, words_per_chapter: wordsPerChapter, style, auto_settle: autoSettle, intent: intent.trim(), audience: audience.trim() },
        });
        setTitleSuggestions([]);
        await openJob(job.id);
      } catch (e) {
        console.error('create job failed', e);
        toast.show('创建失败，请重试', 'error');
      }
      return;
    }
    // 未选定作品（新建小说入口）：书名需填写，提交时先建作品（含简介）再开启全本创作
    const t = title.trim();
    if (!t) {
      toast.show('请填写作品名，或点击「AI填入」自动起名', 'error');
      return;
    }
    try {
      const novel = await createNovel({ title: t, description: description.trim() });
      if (novel?.id) await selectNovel(novel);
      const job = await createJob({
        novel_id: novel.id,
        title: t,
        logline: log,
        config: { chapter_count: chapterCount, words_per_chapter: wordsPerChapter, style, auto_settle: autoSettle, intent: intent.trim(), audience: audience.trim() },
      });
      setTitleSuggestions([]);
      await openJob(job.id);
    } catch (e) {
      console.error('create novel+job failed', e);
      toast.show('创建失败，请重试', 'error');
    }
  };

  // AI 填写书名：以一句话创意为种子，调用 AI 生成候选书名（DEV 降级为本地启发式）
  const handleAIFill = async () => {
    if (!logline.trim()) {
      toast.show('请先填写一句话创意，AI 才能据此起名', 'error');
      return;
    }
    setAiFilling(true);
    try {
      const titles = await suggestStoryTitle(logline.trim(), 5);
      if (titles.length) {
        setTitle(titles[0]);
        setTitleSuggestions(titles.slice(0, 5));
      } else {
        toast.show('AI 未返回书名，可手动填写', 'error');
      }
    } catch (e) {
      console.error('ai fill title failed', e);
      toast.show('AI 起名失败，请稍后重试', 'error');
    } finally {
      setAiFilling(false);
    }
  };

  // 简介保存（编辑入口已迁至此处，替代原概览页的编辑）
  const handleSaveDescription = async () => {
    if (!currentNovel) return;
    try {
      await updateNovel(currentNovel.id, { description: description.trim() });
      toast.show('简介已保存', 'success');
    } catch {
      toast.show('简介保存失败，请重试', 'error');
    }
  };

  const handleGenerate = async () => {
    if (!activeJob) return;
    try {
      await generateStage(activeJob.id);
    } catch {
      // store 已 toast
    }
  };

  const handleAdvance = async () => {
    if (!activeJob) return;
    try {
      await advanceStage(activeJob.id);
      await refreshActive();
    } catch (e) {
      console.error('advance failed', e);
    }
  };

  // 滑动选择器：拖动时手柄连续跟随指针（dragRatio），仅用最近节点高亮标签。
  // 用轨道内条的真实 rect 计算比例，消除 px-2 padding 造成的偏移。
  const handleTrackPointer = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setDragRatio(ratio);
    setDragStageIdx(Math.round(ratio * (STAGE_ORDER.length - 1)));
  };

  const handleDragEnd = async () => {
    if (dragStageIdx == null || !activeJob) {
      setDragStageIdx(null);
      setDragRatio(null);
      return;
    }
    const target = STAGE_ORDER[dragStageIdx];
    // 关键修复：松手后保持手柄停在拖放点（dragRatio 不立即清空），等
    // jumpStage 的 POST 返回、stageIndex 更新后再统一清空。否则手柄会先
    // 弹回旧阶段、等服务端确认再跳到新阶段 —— 这就是用户看到的「抖动」。
    try {
      if (target !== activeJob.stage) {
        // jumpStage already updates activeJob from the POST response, so no
        // follow-up GET is needed — that extra request was also what 429'd
        // (and got silently swallowed) under the old 1 req/s AI bucket.
        await jumpStage(activeJob.id, target);
      }
    } catch (e) {
      console.error('jump stage failed', e);
    } finally {
      setDragStageIdx(null);
      setDragRatio(null);
    }
  };

  const handleAdopt = async () => {
    if (!activeJob) return;
    const payload = activeJob.stage_payload;
    const content = (payload?.content as string) || '';
    if (!content) {
      toast.show('当前没有可采纳的正文', 'error');
      return;
    }
    // 用 stage_payload 的目标章节标题，无则用阶段名
    const chapterTitle = (payload as Record<string, unknown>)?.title as string | undefined;
    const key = `ch-${activeJob.chapter_keys + 1}`;
    try {
      await adoptChapter(activeJob.id, {
        chapter_key: key,
        title: chapterTitle || `第 ${activeJob.chapter_keys + 1} 章`,
        content,
      });
    } catch {
      // store 已 toast
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('确定删除该创作任务？（不影响已采纳的章节）')) return;
    try {
      await removeJob(id);
    } catch (e) {
      console.error('delete job failed', e);
    }
  };

  const stageIndex = activeJob ? STAGE_ORDER.indexOf(activeJob.stage) : -1;

  const backToOverview = () => useUIStore.getState().setCenterTab('overview');

  return (
    <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
      {/* 背景光晕 */}
      <div className="absolute top-1/4 left-1/3 w-80 h-80 rounded-full bg-indigo-600/10 blur-[110px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

      <div className="relative w-full max-w-2xl max-h-full overflow-y-auto px-8 py-10 animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-md shadow-violet-500/20">
              <Wand2 size={16} className="text-white" />
            </span>
            <span className="text-base font-semibold text-neutral-100">AI 起稿 · 全本创作</span>
          </div>
          {activeJob ? (
            <button onClick={closeJob} className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
              ← 返回任务列表
            </button>
          ) : (
            <button onClick={backToOverview} className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
              返回作品概览 →
            </button>
          )}
        </div>

      {!activeJob ? (
        <div>
          {/* 创建表单 */}
          <div className="rounded-xl bg-white/4 border border-white/8 p-3 mb-3">
            <p className="text-xs text-neutral-400 mb-3">输入一句话创意，AI 自动跑完全本创作流水线</p>

            {/* 书名（两端通用，可手动更改，支持 AI 笔填入） */}
            <div className="mb-3">
              <label className="block text-[11px] text-neutral-400 mb-1">书名</label>
              <div className="flex items-center gap-2">
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleSuggestions([]);
                  }}
                  placeholder="书名（如：剑试天下）"
                  className="flex-1 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
                />
                <button
                  type="button"
                  onClick={handleAIFill}
                  disabled={aiFilling}
                  title="AI 根据创意自动起名"
                  className="shrink-0 flex items-center gap-1 px-2.5 py-2 text-xs rounded-lg bg-violet-500/15 text-violet-200 border border-violet-500/30 hover:bg-violet-500/25 disabled:opacity-50 transition-colors"
                >
                  {aiFilling ? <Loader2 size={13} className="animate-spin" /> : <PenLine size={13} />}
                  AI填入
                </button>
              </div>
              {titleSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {titleSuggestions.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setTitle(s)}
                      className="px-2 py-1 text-[11px] rounded-md bg-white/5 border border-white/10 text-neutral-300 hover:border-violet-500/40 hover:text-violet-200 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 简介（编辑入口已迁至此处，替代原概览页的只读/编辑） */}
            <div className="mb-3">
              <label className="block text-[11px] text-neutral-400 mb-1">简介</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="作品简介（可选），帮助 AI 更好地理解你的故事…"
                className="w-full px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 resize-y"
              />
              {currentNovel && description.trim() !== (currentNovel.description ?? '') && (
                <button
                  type="button"
                  onClick={handleSaveDescription}
                  className="mt-1.5 flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                >
                  <Check size={13} /> 保存简介
                </button>
              )}
            </div>

            <textarea
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
              placeholder="书名或创意（如：少年负剑出山，搅动江湖风云）"
              rows={2}
              className="w-full mb-3 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 resize-none"
            />

            {/* 生成设置（动态滑条） */}
            <div className="mb-2 p-2.5 rounded-lg bg-white/3 border border-white/6">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-neutral-400">全书章节数</span>
                <span className="text-[11px] text-violet-300 font-medium">{chapterCount} 章</span>
              </div>
              <input
                type="range"
                min={3}
                max={50}
                step={1}
                value={chapterCount}
                onChange={(e) => setChapterCount(Number(e.target.value))}
                className="w-full accent-violet-500"
              />
              <div className="flex items-center justify-between mt-2 mb-1">
                <span className="text-[11px] text-neutral-400">每章字数</span>
                <span className="text-[11px] text-violet-300 font-medium">{wordsPerChapter} 字</span>
              </div>
              <input
                type="range"
                min={500}
                max={5000}
                step={100}
                value={wordsPerChapter}
                onChange={(e) => setWordsPerChapter(Number(e.target.value))}
                className="w-full accent-violet-500"
              />
              <input
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="文风（可选，如：冷峻武侠 / 轻松甜宠）"
                className="w-full mt-2 px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
              />
              <input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="目标受众（可选，如：15-25 岁网文读者 / 都市女性）"
                className="w-full mt-2 px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
              />
              <input
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="创作意图（可选，如：爽文爽感优先 / 情感共鸣 / 悬疑反转）"
                className="w-full mt-2 px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
              />
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSettle}
                  onChange={(e) => setAutoSettle(e.target.checked)}
                  className="accent-violet-500"
                />
                <span className="text-[11px] text-neutral-400">采纳后自动沉淀设定/角色/图谱/伏笔</span>
              </label>
            </div>

            {currentNovel ? (
              <button
                onClick={handleCreate}
                className="w-full py-2 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition-all"
              >
                <Wand2 size={14} className="inline mr-1.5" />
                为「{title.trim() || currentNovel.title}」创建创作任务
              </button>
            ) : (
              <button
                onClick={handleCreate}
                className="w-full py-2 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition-all"
              >
                <Wand2 size={14} className="inline mr-1.5" />
                创建作品并开启全本创作
              </button>
            )}
          </div>

          {/* 任务列表 */}
          {loading ? (
            <div className="flex items-center justify-center py-8 text-neutral-500">
              <Loader2 size={16} className="animate-spin mr-2" />
              加载中…
            </div>
          ) : jobs.length === 0 ? (
            <p className="text-xs text-neutral-500 text-center py-8">还没有创作任务</p>
          ) : (
            <div className="flex flex-col gap-2">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} onOpen={() => openJob(job.id)} onDelete={() => handleDelete(job.id)} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          {/* 阶段进度 */}
          <div className="rounded-xl bg-white/4 border border-white/8 p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-neutral-200">{activeJob.title}</div>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">
                {STORY_STAGE_LABELS[activeJob.stage]}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mb-3">{activeJob.logline}</p>
            {/* 阶段节点条（可点击滑动到目标阶段） */}
            {/* 滑动选择器：可拖动选择任意阶段（不限定顺序） */}
            <div
              ref={trackRef}
              className="relative mb-3 px-2 pt-4 pb-1 select-none touch-none cursor-pointer"
              onPointerMove={(e) => {
                if (dragRatio !== null) handleTrackPointer(e);
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                handleTrackPointer(e);
              }}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
            >
              {(() => {
                const n = STAGE_ORDER.length - 1;
                const activeIdx = dragStageIdx ?? stageIndex;
                // 拖动中手柄连续跟随指针；否则吸附到当前阶段节点
                const pct = (dragRatio !== null ? dragRatio : activeIdx / n) * 100;
                const dragging = dragRatio !== null;
                const moveCls = dragging ? '' : 'transition-[left,width] duration-200 ease-out';
                return (
                  <div ref={barRef} className="absolute left-0 right-0 top-[7px] h-1 rounded-full">
                    {/* 轨道背景 */}
                    <div className="absolute inset-0 h-full rounded-full bg-white/10" />
                    {/* 已走过路径 */}
                    <div
                      className={`absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 ${moveCls}`}
                      style={{ width: `${pct}%` }}
                    />
                    {/* 滑块手柄（拖动时放大、连续跟随；松手后平滑吸附） */}
                    <div
                      className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full shadow-lg ${dragStageIdx !== null ? 'scale-110 ' : ''}${dragging ? 'transition-transform' : 'transition-[left,transform] duration-200 ease-out'}`}
                      style={{
                        left: `${pct}%`,
                        background: 'linear-gradient(135deg, #8b5cf6, #d946ef)',
                        boxShadow: '0 0 0 4px rgba(139,92,246,0.2)',
                      }}
                      title={`当前: ${STORY_STAGE_LABELS[STAGE_ORDER[activeIdx]]}`}
                    />
                  </div>
                );
              })()}
              {/* 节点标签 */}
              <div className="flex items-start">
                {STAGE_ORDER.map((st, idx) => {
                  const activeIdx = dragStageIdx ?? stageIndex;
                  const current = idx === activeIdx;
                  const reached = idx <= activeIdx;
                  return (
                    <div
                      key={st}
                      className={`flex-1 flex flex-col items-center gap-1 text-[9px] transition-colors ${current ? 'text-violet-300 font-medium' : reached ? 'text-neutral-400' : 'text-neutral-600'}`}
                    >
                      {STORY_STAGE_LABELS[st]}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex-1 py-1.5 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 text-xs font-medium transition-all disabled:opacity-50"
              >
                {generating ? <Loader2 size={13} className="inline mr-1 animate-spin" /> : <Play size={13} className="inline mr-1" />}
                {generating ? '生成中…' : '生成当前阶段'}
              </button>
              <button
                onClick={handleAdvance}
                disabled={activeJob.status === 'done'}
                className="flex-1 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium transition-all disabled:opacity-40"
              >
                <ArrowRight size={13} className="inline mr-1" />
                {activeJob.status === 'done' ? '已完成' : '下一阶段'}
              </button>
            </div>
          </div>

          {/* 阶段产物预览 */}
                    <StagePreview
                        job={activeJob}
                        expanded={expandedContent}
                        onToggleExpand={() => setExpandedContent(!expandedContent)}
                        onAdopt={handleAdopt}
                        adopting={adopting}
                        onRefresh={refreshActive}
                        onAdvance={handleAdvance}
                    />
        </div>
      )}
      </div>
    </div>
  );
};

/** 单个任务卡片 */
const JobCard: React.FC<{ job: StoryJob; onOpen: () => void; onDelete: () => void }> = ({ job, onOpen, onDelete }) => {
  return (
    <div className="rounded-xl bg-white/4 border border-white/8 p-3">
      <div className="flex items-start justify-between">
        <button onClick={onOpen} className="flex-1 text-left">
          <div className="text-sm text-neutral-200 font-medium">{job.title}</div>
          <div className="text-[11px] text-neutral-500 mt-0.5 line-clamp-1">{job.logline}</div>
        </button>
        <button onClick={onDelete} className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10" title="删除">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/12 text-violet-300 border border-violet-500/25">
          {STORY_STAGE_LABELS[job.stage]}
        </span>
        <span className="text-[11px] text-neutral-500">
          {job.chapter_keys} 章已采纳 · 阶段 {job.progress}/{job.total_steps}
        </span>
      </div>
    </div>
  );
};

/** 阶段产物预览（大纲/正文） */
const StagePreview: React.FC<{
  job: StoryJob;
  expanded: boolean;
  onToggleExpand: () => void;
  onAdopt: () => void;
  adopting: boolean;
  onRefresh: () => void;
  onAdvance: () => void;
}> = ({ job, expanded, onToggleExpand, onAdopt, adopting, onRefresh, onAdvance }) => {
  // 预览以「当前查看阶段」的快照为准：切换回历史阶段时展示当时生成的结果，
  // 而非总是当前 stage_payload（stage_payload 仅保留最新一次生成 + 采纳记录）。
  const snap = job.stage_snapshots?.[job.stage] ?? job.stage_payload;
  const content = (snap?.content as string) || '';
  const isVerify = job.stage === 'verify';
  const issues = snap?.issues || [];
  const candidates = snap?.settled?.foreshadow_candidates || [];

  // verify 阶段：展示一致性报告（无正文 content）
  if (isVerify) {
    return (
      <div className="rounded-xl bg-white/4 border border-white/8 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-neutral-300">一致性校验报告</span>
          <button onClick={onRefresh} className="p-1 rounded text-neutral-500 hover:text-neutral-300" title="刷新">
            <RefreshCw size={12} />
          </button>
        </div>
        {issues.length === 0 ? (
          <p className="text-sm text-emerald-400">✓ 未发现一致性冲突</p>
        ) : (
          <div className="flex flex-col gap-2">
            {issues.map((it, i) => (
              <div key={i} className="text-xs text-neutral-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-2">
                {it.description || JSON.stringify(it)}
              </div>
            ))}
          </div>
        )}
        {snap?.degraded && (
          <p className="text-[11px] text-neutral-500 mt-2">（一致性检查不可用，已降级跳过）</p>
        )}
      </div>
    );
  }

  if (!content) {
    return (
      <div className="text-xs text-neutral-500 text-center py-8">
        {job.last_error ? (
          <span className="text-red-400">{job.last_error}</span>
        ) : (
          '点击「生成当前阶段」让 AI 产出内容'
        )}
      </div>
    );
  }

  // 大纲阶段：内容可能较短；成稿阶段：正文长，折叠展示
  const isDraft = job.stage === 'draft_chapter';

  return (
    <div className="rounded-xl bg-white/4 border border-white/8 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-neutral-300">
          {snap?.scene === 'chapter' ? '本章正文' : '阶段产物'}
          {snap?.generated ? (
            <span className="text-neutral-600 ml-2 text-[10px]">
              {new Date(snap.generated).toLocaleTimeString()}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} className="p-1 rounded text-neutral-500 hover:text-neutral-300" title="刷新">
            <RefreshCw size={12} />
          </button>
          {isDraft && (
            <button
              onClick={onToggleExpand}
              className="p-1 rounded text-neutral-500 hover:text-neutral-300"
              title={expanded ? '收起' : '展开'}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>

      <div
        className={`text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap ${
          isDraft && !expanded ? 'max-h-40 overflow-hidden' : ''
        }`}
      >
        {content}
      </div>

      {isDraft && !expanded && (
        <button onClick={onToggleExpand} className="mt-1 text-[11px] text-violet-400 hover:text-violet-300">
          {expanded ? '收起' : '展开全文'}
        </button>
      )}

      {isDraft && (
        <button
          onClick={onAdopt}
          disabled={adopting}
          className="mt-3 w-full py-2 rounded-lg bg-fuchsia-600/20 hover:bg-fuchsia-600/30 text-fuchsia-300 text-sm font-medium transition-all disabled:opacity-50"
        >
          {adopting ? <Loader2 size={14} className="inline mr-1 animate-spin" /> : <Check size={14} className="inline mr-1" />}
          {adopting ? '采纳中…' : '采纳到章节'}
        </button>
      )}

      {/* 非成稿阶段：底部给出「采纳本阶段并继续」按钮（采纳=确认该阶段结果并推进） */}
      {!isDraft && (
        <button
          onClick={onAdvance}
          className="mt-3 w-full py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 text-sm font-medium transition-all"
        >
          <ArrowRight size={14} className="inline mr-1" />
          采纳本阶段并进入下一阶段
        </button>
      )}

      {/* 闭环沉淀结果：知识图谱 + 伏笔候选 */}
      {candidates.length > 0 && (
        <div className="mt-3 border-t border-white/6 pt-2">
          <p className="text-[11px] text-neutral-400 mb-1.5">已自动沉淀 · 伏笔候选（待你确认）</p>
          <div className="flex flex-col gap-1">
            {candidates.map((c, i) => (
              <div key={i} className="text-[11px] text-neutral-300 bg-white/3 border border-white/8 rounded-md px-2 py-1.5">
                <span className="text-amber-300">{Math.round((c.confidence || 0) * 100)}%</span> {c.description}
              </div>
            ))}
          </div>
        </div>
      )}
      {snap?.settled?.knowledge_nodes ? (
        <p className="mt-2 text-[11px] text-emerald-400/80">✓ 已提取实体入知识图谱</p>
      ) : null}
    </div>
  );
};

export default StoryWorkflowPanel;
