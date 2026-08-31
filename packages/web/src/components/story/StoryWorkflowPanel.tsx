import React, { useEffect, useState } from 'react';
import { Wand2, Play, ArrowRight, Check, Trash2, Loader2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useStoryStore, STAGE_ORDER } from '@/stores/story-store';
import { STORY_STAGE_LABELS } from '@/services/story-client';
import type { StoryJob } from '@/services/story-client';
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
  const [autoSettle, setAutoSettle] = useState(true);

  // 加载当前作品的任务
  useEffect(() => {
    if (currentNovel?.id) loadJobs(currentNovel.id);
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!currentNovel?.id) {
      toast.show('请先打开一个作品', 'error');
      return;
    }
    if (!title.trim() || !logline.trim()) {
      toast.show('请填写作品名与一句话创意', 'error');
      return;
    }
    try {
      const job = await createJob({
        novel_id: currentNovel.id,
        title: title.trim(),
        logline: logline.trim(),
        config: { chapter_count: chapterCount, words_per_chapter: wordsPerChapter, style, auto_settle: autoSettle },
      });
      setTitle('');
      setLogline('');
      await openJob(job.id);
    } catch (e) {
      console.error('create job failed', e);
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-white/6 shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-md shadow-violet-500/20">
            <Wand2 size={13} className="text-white" />
          </span>
          <span className="text-sm font-medium text-neutral-200">AI 起稿 · 全本创作</span>
        </div>
        {activeJob && (
          <button onClick={closeJob} className="mt-1.5 text-xs text-neutral-500 hover:text-neutral-300">
            ← 返回任务列表
          </button>
        )}
      </div>

      {!activeJob ? (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {/* 创建表单 */}
          <div className="rounded-xl bg-white/4 border border-white/8 p-3 mb-3">
            <p className="text-xs text-neutral-400 mb-2">输入一句话创意，AI 自动跑完全本创作流水线</p>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="作品名（如：剑试天下）"
              className="w-full mb-2 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
            />
            <textarea
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
              placeholder="一句话创意（如：少年负剑出山，搅动江湖风云）"
              rows={2}
              className="w-full mb-2 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 resize-none"
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

            <button
              onClick={handleCreate}
              disabled={!currentNovel}
              className="w-full py-2 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition-all disabled:from-neutral-700 disabled:to-neutral-700 disabled:text-neutral-500"
            >
              <Wand2 size={14} className="inline mr-1.5" />
              创建创作任务
            </button>
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
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {/* 阶段进度 */}
          <div className="rounded-xl bg-white/4 border border-white/8 p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-neutral-200">{activeJob.title}</div>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">
                {STORY_STAGE_LABELS[activeJob.stage]}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mb-3">{activeJob.logline}</p>
            {/* 阶段条 */}
            <div className="flex items-center gap-1 mb-3">
              {STAGE_ORDER.map((st, idx) => {
                const reached = idx <= stageIndex;
                const current = idx === stageIndex;
                return (
                  <React.Fragment key={st}>
                    <div
                      className={`flex-1 h-1.5 rounded-full transition-colors ${
                        reached ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500' : 'bg-white/8'
                      } ${current ? 'ring-2 ring-violet-400/40' : ''}`}
                    />
                    {idx < STAGE_ORDER.length - 1 && <span className="text-[9px] text-neutral-600">·</span>}
                  </React.Fragment>
                );
              })}
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
          />
        </div>
      )}
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
}> = ({ job, expanded, onToggleExpand, onAdopt, adopting, onRefresh }) => {
  const content = (job.stage_payload?.content as string) || '';
  const isVerify = job.stage === 'verify';
  const issues = job.stage_payload?.issues || [];
  const candidates = job.stage_payload?.settled?.foreshadow_candidates || [];

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
        {job.stage_payload?.degraded && (
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
          {job.stage_payload?.scene === 'chapter' ? '本章正文' : '阶段产物'}
          {job.stage_payload?.generated ? (
            <span className="text-neutral-600 ml-2 text-[10px]">
              {new Date(job.stage_payload.generated).toLocaleTimeString()}
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
      {job.stage_payload?.settled?.knowledge_nodes ? (
        <p className="mt-2 text-[11px] text-emerald-400/80">✓ 已提取实体入知识图谱</p>
      ) : null}
    </div>
  );
};

export default StoryWorkflowPanel;
