import React, { useEffect, useRef, useState } from 'react';
import { Wand2, Play, ArrowRight, Check, Trash2, Loader2, ChevronDown, ChevronUp, RefreshCw, Sparkles, X } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useStoryStore, STAGE_ORDER } from '@/stores/story-store';
import { useTabStore, overviewTabKey } from '@/stores/tab-store';
import { STORY_STAGE_LABELS } from '@/services/story-client';
import type { StoryJob } from '@/services/story-client';
import { generateStoryOverview } from '@/services/ai-actions-client';
import type { StoryOverviewContext, StoryOverviewField, StoryOverviewClue, StoryOverviewClueKind } from '@/services/ai-actions-client';
import { fetchOutline } from '@/services/outline-client';
import { fetchMemory } from '@/services/memory-client';
import { listForeshadows } from '@/services/foreshadow-client';
import type { CreateNovelRequest, UpdateNovelRequest } from '@/types';
import { toast } from '@/components/common/Toast';
import { confirmDialog } from '@/components/common/ConfirmDialog';
import AigcCard from '@/components/ai/AigcCard';
import type { AigcClueContext } from '@/components/ai/AigcCard';
import { architectureText, useArchitectureStore } from '@/stores/architecture-store';
import { buildAccessEvalContext, evaluateAccess } from '@/utils/memory-access';

/** 概览字段中文名（覆盖警告与提示文案用） */
const OVERVIEW_FIELD_LABELS: Record<StoryOverviewField, string> = {
  title: '书名',
  description: '简介',
  logline: '创意',
  style: '文风',
  audience: '受众',
  intent: '意图',
};

/**
 * 概览草稿：本地暂存尚未入库的改动。
 * 创意（logline）不入作品表，面板卸载即丢，必须靠它跨「切到概览页/任务页再回来」与刷新保留；
 * 其余五字段入库成功后即清草稿，草稿只承载未入库改动，避免遮蔽他处（如概览页）的修改。
 */
type OverviewDraft = Partial<Pick<StoryOverviewContext, 'title' | 'description' | 'logline' | 'style' | 'audience' | 'intent'>>;
const DRAFT_KEY = (scope: string) => `inkbloom:story-draft:${scope}`;
const readDraft = (scope: string): OverviewDraft | null => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(scope));
    return raw ? (JSON.parse(raw) as OverviewDraft) : null;
  } catch {
    return null;
  }
};
const writeDraft = (scope: string, draft: OverviewDraft) => {
  try {
    localStorage.setItem(DRAFT_KEY(scope), JSON.stringify(draft));
  } catch {
    /* 配额不足 / 隐私模式：草稿丢失不影响主流程 */
  }
};
const clearDraft = (scope: string) => {
  try {
    localStorage.removeItem(DRAFT_KEY(scope));
  } catch {
    /* ignore */
  }
};

/** 概览字段行：标签 + 常驻可编辑的受控输入（右侧常驻 AI 单项生成按钮）+ 自适应文本域 */
const OverviewFieldRow: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  filling: boolean;
  busy: boolean;
  onAIFill: () => void;
  textarea?: boolean;
  rows?: number;
  placeholder?: string;
}> = ({ label, value, onChange, filling, busy, onAIFill, textarea, rows, placeholder }) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 自适应文本域：内容变化时按 scrollHeight 撑高（限制上限），输入多长都不出滚动条
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const minH = (rows ?? 3) * 20 + 16;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), 220)}px`;
  }, [value, rows]);
  const inputCls =
    'w-full text-sm rounded-lg transition-colors px-2.5 py-2 pr-10 bg-white/5 border border-white/8 focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500';
  return (
    <div className="mb-3">
      <label className="block text-[11px] text-neutral-400 mb-1">{label}</label>
      <div className="relative">
        {textarea ? (
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={rows ?? 3}
            placeholder={placeholder}
            className={`${inputCls} resize-none overflow-hidden`}
          />
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={inputCls}
          />
        )}
        <button
          type="button"
          onClick={onAIFill}
          disabled={filling || busy}
          title={`AI 生成${label}${value.trim() ? '（将覆盖现有内容）' : ''}`}
          className={`absolute right-2 p-1.5 rounded-md text-violet-300 hover:bg-violet-500/15 border border-transparent hover:border-violet-500/30 disabled:opacity-50 transition-colors ${
            textarea ? 'top-2' : 'top-1/2 -translate-y-1/2'
          }`}
        >
          {filling ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        </button>
      </div>
    </div>
  );
};

/**
 * Agent 全本创作工作流面板（AI 起稿 Home tab，可关闭）。
 *
 * 从一句话创意出发，驱动 story_jobs 状态机逐步生成：
 *   创意 → 大纲 → 分章 → 成稿（逐章预览/采纳）→ 校验 → 定稿。
 * AI 产物先进 stage_payload（预览态），作者点「采纳」才写入真实章节。
 */
interface StoryWorkflowPanelProps {
  /** 所属 Home tab key：关闭/返回按钮直接关闭该 tab */
  tabKey?: string;
}
const StoryWorkflowPanel: React.FC<StoryWorkflowPanelProps> = ({ tabKey }) => {
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
  // 生成设置（动态滑条 + 沉淀开关）；文风/受众/意图已上移为概览字段统一管理
  const [chapterCount, setChapterCount] = useState(10);
  const [wordsPerChapter, setWordsPerChapter] = useState(2000);
  const [style, setStyle] = useState('');
  const [audience, setAudience] = useState('');
  const [intent, setIntent] = useState('');
  const [autoSettle, setAutoSettle] = useState(true);
  // AIGC：正在生成的概览字段（null = 空闲）；fillingAll = 全概览一键生成中
  const [fillingField, setFillingField] = useState<StoryOverviewField | null>(null);
  const [fillingAll, setFillingAll] = useState(false);
  // 线索库摘录（供单项 ✦ 生成使用；全概览生成走 AIGC 卡的上下文勾选快照）
  const cluesRef = useRef<StoryOverviewClue[]>([]);
  // 概览字段常驻可编辑：改动先落本地草稿，再防抖自动入库（无需编辑开关/完成按钮）
  const savingRef = useRef(false);
  // 「取消」的回滚基线 = 服务端已存的 currentNovel 值（字段常驻可编辑，无独立编辑态）
  // 滑动选择器：拖动中的节点索引（仅用于标签高亮），以及连续指针比例（手柄实际跟随）
  const [dragStageIdx, setDragStageIdx] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // 简介：随当前作品预填；作品简介在别处更新后回填本面板。
  // 守卫：本面板自动保存期间不回填，否则会把用户正在输入的内容回卷成已入库值。
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (savingRef.current) return;
    setDescription(currentNovel?.description ?? '');
  }, [currentNovel?.id, currentNovel?.description]);
  // 切换作品：预填 = 服务端值，本地草稿（未入库改动 + 创意）优先覆盖
  useEffect(() => {
    const draft = readDraft(currentNovel ? String(currentNovel.id) : 'new');
    if (currentNovel) {
      setTitle(draft?.title ?? currentNovel.title);
      setDescription(draft?.description ?? currentNovel.description ?? '');
      setStyle(draft?.style ?? currentNovel.style ?? '');
      setAudience(draft?.audience ?? currentNovel.audience ?? '');
      setIntent(draft?.intent ?? currentNovel.intent ?? '');
    } else {
      setTitle(draft?.title ?? '');
      setDescription(draft?.description ?? '');
      setStyle(draft?.style ?? '');
      setAudience(draft?.audience ?? '');
      setIntent(draft?.intent ?? '');
    }
    // 创意不入作品表，只可能来自草稿 —— 这是「输入后切页/刷新仍保留」的关键
    setLogline(draft?.logline ?? '');
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 拉取当前作品的线索库（架构/大纲/记忆/伏笔）内容摘录 → cluesRef，
  // 供单项 ✦ 生成使用；全概览生成走顶部 AIGC 卡的上下文勾选快照（同一套来源）。
  // 概览已填信息默认注入思考上下文（后端始终携带全部概览字段）。
  useEffect(() => {
    const id = currentNovel?.id;
    if (!id) {
      cluesRef.current = [];
      return;
    }
    let alive = true;
    void (async () => {
      const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cap = (s: string) => (s.length > 1200 ? `${s.slice(0, 1200)}…` : s);
      // 架构线索（本地预制 store，当前作品时用流派预填基本信息）
      useArchitectureStore.getState().ensure(id, currentNovel?.genre);
      const architecture = architectureText(id);
      const [outlineR, memoryR, foresR] = await Promise.allSettled([
        fetchOutline(id),
        fetchMemory(id),
        listForeshadows(id),
      ]);
      if (!alive) return;
      const outline =
        outlineR.status === 'fulfilled'
          ? outlineR.value
              .map((act) => {
                const nodes = act.nodes
                  .map((n) => `${n.title}${stripTags(n.summary) ? `（${stripTags(n.summary)}）` : ''}`)
                  .filter(Boolean)
                  .join('；');
                return nodes ? `${act.title}：${nodes}` : act.title;
              })
              .filter(Boolean)
              .join('；')
          : '';
      const memory =
        memoryR.status === 'fulfilled'
          ? memoryR.value.items
              // AI 访问闸门（六模式）求值：创意阶段无写作位置，位置型硬闸
              // fail-closed 不进线索；软闸条目照常提供（与服务端同规则镜像）。
              .filter(
                (it) =>
                  evaluateAccess(it, buildAccessEvalContext(outlineR.status === 'fulfilled' ? outlineR.value : [])).inject &&
                  (it.name || it.content),
              )
              .map((it) => `${it.name ? `${it.name}：` : ''}${stripTags(it.content)}`)
              .filter(Boolean)
              .join('；')
          : '';
      const foreshadow =
        foresR.status === 'fulfilled'
          ? foresR.value
              .filter((f) => f.status === 'planted' || f.status === 'reminded')
              .map((f) => f.description)
              .join('；')
          : '';
      const clues: StoryOverviewClue[] = [];
      if (architecture.trim()) clues.push({ kind: 'architecture', content: cap(architecture) });
      if (outline.trim()) clues.push({ kind: 'outline', content: cap(outline) });
      if (memory.trim()) clues.push({ kind: 'memory', content: cap(memory) });
      if (foreshadow.trim()) clues.push({ kind: 'foreshadow', content: cap(foreshadow) });
      if (alive) cluesRef.current = clues;
    })();
    return () => {
      alive = false;
    };
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 加载当前作品的任务
  useEffect(() => {
    if (currentNovel?.id) loadJobs(currentNovel.id);
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— 概览字段读写助手 ——
  const getOverviewField = (field: StoryOverviewField): string => {
    switch (field) {
      case 'title': return title;
      case 'description': return description;
      case 'logline': return logline;
      case 'style': return style;
      case 'audience': return audience;
      case 'intent': return intent;
    }
  };

  const setOverviewField = (field: StoryOverviewField, value: string) => {
    if (field === 'title') setTitle(value);
    else if (field === 'description') setDescription(value);
    else if (field === 'logline') setLogline(value);
    else if (field === 'style') setStyle(value);
    else if (field === 'audience') setAudience(value);
    else setIntent(value);
  };

  // 比对本地字段与当前作品，构造概览脏字段补丁（含书名；保存后经 store 同步概览页/书列表）
  const buildOverviewPatch = (): UpdateNovelRequest => {
    const patch: UpdateNovelRequest = {};
    if (!currentNovel) return patch;
    const t = title.trim() || currentNovel.title;
    if (t !== currentNovel.title) patch.title = t;
    if (description.trim() !== (currentNovel.description ?? '')) patch.description = description.trim();
    if (style.trim() !== (currentNovel.style ?? '')) patch.style = style.trim();
    if (audience.trim() !== (currentNovel.audience ?? '')) patch.audience = audience.trim();
    if (intent.trim() !== (currentNovel.intent ?? '')) patch.intent = intent.trim();
    return patch;
  };

  const handleCreate = async () => {
    const log = logline.trim();
    if (!log) {
      toast.show('请填写一句话创意', 'error');
      return;
    }
    const jobConfig = {
      chapter_count: chapterCount,
      words_per_chapter: wordsPerChapter,
      style: style.trim(),
      auto_settle: autoSettle,
      intent: intent.trim(),
      audience: audience.trim(),
    };
    // 已选定作品：先持久化概览脏字段（含书名），再开启全本创作
    if (currentNovel?.id) {
      try {
        // 书名被清空时不提交空名：回填为当前书名
        if (!title.trim()) setTitle(currentNovel.title);
        const patch = buildOverviewPatch();
        if (Object.keys(patch).length) await updateNovel(currentNovel.id, patch);
        const job = await createJob({
          novel_id: currentNovel.id,
          title: title.trim() || currentNovel.title,
          logline: log,
          config: jobConfig,
        });
        await openJob(job.id);
      } catch (e) {
        console.error('create job failed', e);
        toast.show('创建失败，请重试', 'error');
      }
      return;
    }
    // 未选定作品（新建小说入口）：书名需填写，提交时先建作品（含概览字段）再开启全本创作
    const t = title.trim();
    if (!t) {
      toast.show('请填写作品名，或开启 AIGC 让 AI 自动起名', 'error');
      return;
    }
    try {
      const createReq: CreateNovelRequest = {
        title: t,
        description: description.trim(),
        style: style.trim() || undefined,
        audience: audience.trim() || undefined,
        intent: intent.trim() || undefined,
      };
      const novel = await createNovel(createReq);
      if (novel?.id) await selectNovel(novel);
      // 创意（logline）不入作品表：把 'new' 草稿迁到新作品作用域，避免回到表单后创意被清空
      if (log.trim()) writeDraft(String(novel.id), { logline: log.trim() });
      clearDraft('new'); // 其余字段已随作品入库，无需保留
      const job = await createJob({
        novel_id: novel.id,
        title: t,
        logline: log,
        config: jobConfig,
      });
      await openJob(job.id);
    } catch (e) {
      console.error('create novel+job failed', e);
      toast.show('创建失败，请重试', 'error');
    }
  };

  // 草稿落盘：只存「与服务端不一致的字段 + 创意」，完全一致时清掉草稿 ——
  // 否则残留草稿会遮蔽他处（概览页/书列表改名）的修改。无作品（新建入口）时全部入草稿。
  useEffect(() => {
    const scope = currentNovel ? String(currentNovel.id) : 'new';
    const timer = setTimeout(() => {
      const draft: OverviewDraft = {};
      if (!currentNovel) {
        Object.assign(draft, { title, description, logline, style, audience, intent });
      } else {
        if (title.trim() && title.trim() !== currentNovel.title) draft.title = title;
        if (description.trim() !== (currentNovel.description ?? '')) draft.description = description;
        if (style.trim() !== (currentNovel.style ?? '')) draft.style = style;
        if (audience.trim() !== (currentNovel.audience ?? '')) draft.audience = audience;
        if (intent.trim() !== (currentNovel.intent ?? '')) draft.intent = intent;
        if (logline.trim()) draft.logline = logline;
      }
      if (Object.keys(draft).length) writeDraft(scope, draft);
      else clearDraft(scope);
    }, 300);
    return () => clearTimeout(timer);
  }, [title, description, logline, style, audience, intent, currentNovel]);

  // 自动入库：已选作品时概览脏字段（书名/简介/文风/受众/意图）防抖 800ms 写回服务端，
  // 经 store 同步概览页与书列表（需求3）；成功后清草稿。创意不入作品表，只留本地草稿。
  useEffect(() => {
    if (!currentNovel?.id) return;
    const patch = buildOverviewPatch();
    if (!Object.keys(patch).length) return;
    const id = currentNovel.id;
    const timer = setTimeout(async () => {
      savingRef.current = true;
      try {
        await updateNovel(id, patch);
        // 只摘除已入库字段：草稿里可能还躺着未入库的创意，整把清掉会连它一起抹掉
        const rest: OverviewDraft = {};
        if (logline.trim()) rest.logline = logline;
        if (Object.keys(rest).length) writeDraft(String(id), rest);
        else clearDraft(String(id));
      } catch (e) {
        console.error('auto save overview failed', e);
        toast.show('概览保存失败，请重试', 'error');
      } finally {
        setTimeout(() => {
          savingRef.current = false;
        }, 600);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [title, description, style, audience, intent, currentNovel]); // eslint-disable-line react-hooks/exhaustive-deps

  // 线索摘录（cluesRef，切换作品时加载：架构/大纲/记忆/伏笔）——单项 ✦ 生成使用
  const buildClues = (): StoryOverviewClue[] => cluesRef.current;

  // 当前概览六字段上下文（已填信息默认全部注入思考，无需勾选）
  const buildOverviewContext = (): StoryOverviewContext => ({
    title: title.trim(),
    description: description.trim(),
    logline: logline.trim(),
    style: style.trim(),
    audience: audience.trim(),
    intent: intent.trim(),
  });

  // AI 生成单个概览字段（真实链路，无预设兜底，失败直接抛错提示）：
  // 1) 目标字段已有内容时先弹覆盖警告（需求1）
  // 2) 请求携带概览全部字段 + 勾选的线索库摘录，生成结果与已有概览/线索一致（需求6）
  // 3) 编辑态下生成结果只落本地，随「完成」统一保存
  const handleAIFillField = async (field: StoryOverviewField) => {
    if (getOverviewField(field).trim()) {
      if (
        !(await confirmDialog({
          title: '覆盖确认',
          message: `「${OVERVIEW_FIELD_LABELS[field]}」已有内容，AI 生成将覆盖现有内容，是否继续？`,
          danger: true,
        }))
      )
        return;
    }
    setFillingField(field);
    try {
      const out = await generateStoryOverview(buildOverviewContext(), [field], buildClues());
      const value = (out[field] ?? '').trim();
      if (!value) throw new Error('AI 未返回有效内容');
      setOverviewField(field, value);
      // 已选作品时改动由自动保存入库（创意只留本地草稿），不再需要「完成」按钮
      toast.show(`已生成${OVERVIEW_FIELD_LABELS[field]}`, 'success');
    } catch (e) {
      console.error('ai fill field failed', e);
      toast.show('AI 生成失败，请稍后重试', 'error');
    } finally {
      setFillingField(null);
    }
  };

  // AIGC 全概览自动生成（统一 AIGC 卡宿主管线，备忘录 L61）：
  // 一次性接管全部六个字段；任何字段已有内容时先弹覆盖警告，确认后才生成。
  // 上下文 = 卡内勾选的线索快照（架构/大纲/记忆默认勾选，悬念可选）。
  const handleAIGenerateAll = async (_instruction: string, ctx: AigcClueContext) => {
    if (fillingField !== null || fillingAll) return;
    const allFields: StoryOverviewField[] = ['title', 'description', 'logline', 'style', 'audience', 'intent'];
    const filled = allFields.filter((f) => getOverviewField(f).trim());
    if (filled.length) {
      const names = filled.map((f) => `「${OVERVIEW_FIELD_LABELS[f]}」`).join('、');
      if (
        !(await confirmDialog({
          title: '覆盖确认',
          message: `AIGC 将自动接管全部概览填写，${names}已有内容将被覆盖，是否继续？`,
          danger: true,
        }))
      )
        return;
    }
    setFillingAll(true);
    try {
      // 卡内勾选的上下文快照 → 线索库（架构/大纲/记忆/伏笔；章节类线索不适用概览生成）
      const clues: StoryOverviewClue[] = ctx.selected
        .filter((k): k is StoryOverviewClueKind => k !== 'current_chapter' && k !== 'nearby_chapters')
        .map((k) => ({ kind: k, content: ctx.excerpts[k] ?? '' }))
        .filter((c) => c.content.trim());
      const out = await generateStoryOverview(buildOverviewContext(), allFields, clues);
      for (const f of allFields) {
        const v = (out[f] ?? '').trim();
        if (v) setOverviewField(f, v);
      }
      // 生成后六字段均已落到本地，由自动保存 effect 统一入库（无作品时只入草稿）
      toast.show('已生成全部概览', 'success');
    } catch (e) {
      console.error('ai generate all failed', e);
      toast.show('AI 生成失败，请稍后重试', 'error');
    } finally {
      setFillingAll(false);
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
    if (
      !(await confirmDialog({
        title: '删除创作任务',
        message: '确定删除该创作任务？（不影响已采纳的章节）',
        confirmText: '删除',
        danger: true,
      }))
    )
      return;
    try {
      await removeJob(id);
    } catch (e) {
      console.error('delete job failed', e);
    }
  };

  const stageIndex = activeJob ? STAGE_ORDER.indexOf(activeJob.stage) : -1;

  // 返回作品概览：打开当前作品的首页 Home tab 并关闭本页；无当前作品则仅关闭本页
  const backToOverview = () => {
    const st = useTabStore.getState();
    if (currentNovel) {
      st.openPanelTab(overviewTabKey(currentNovel.id), currentNovel.title, 'overview', {
        novelId: currentNovel.id,
      });
    }
    if (tabKey) st.closeTab(tabKey);
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
      {/* 背景光晕 */}
      <div className="absolute top-1/4 left-1/3 w-80 h-80 rounded-full bg-indigo-600/10 blur-[110px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

      <div className="relative w-full max-w-2xl max-h-full overflow-y-auto px-8 py-10 animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          {/* 左侧：标题（AIGC 已改为「全概览自动生成」动作按钮，置于线索勾选卡右侧） */}
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-md shadow-violet-500/20">
              <Wand2 size={16} className="text-white" />
            </span>
            <span className="text-base font-semibold text-neutral-100">AI 起稿 · 全本创作</span>
          </div>
          {/* 右侧：返回入口 + 关闭 X（备忘录 L61：AI 起稿页右上角关闭按钮） */}
          <div className="flex items-center gap-2">
            {activeJob ? (
              <button onClick={closeJob} className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors ml-2">
                ← 返回任务列表
              </button>
            ) : (
              <button onClick={backToOverview} className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors ml-2">
                返回作品概览 →
              </button>
            )}
            <button
              type="button"
              onClick={() => tabKey && useTabStore.getState().closeTab(tabKey)}
              title="关闭 AI 起稿页"
              className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-100 hover:bg-white/10 transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        </div>

      {!activeJob ? (
        <div>
          {/* 创建表单 */}
          <div className="rounded-xl bg-white/4 border border-white/8 p-3 mb-3">
            <p className="text-xs text-neutral-400 mb-3">输入一句话创意，AI 自动跑完全本创作流水线</p>

            {/* 统一 AIGC 配置卡（备忘录 L61）：全概览一键生成；上下文勾选（架构/大纲/记忆
                默认勾选，悬念可选）在卡内完成，附加指令可选输入 */}
            <AigcCard
              novelId={currentNovel?.id}
              scene="summary"
              taskLabel="AIGC · 全概览"
              hint="AI 接管全部概览字段（已填内容将被覆盖）"
              buildInstruction={(extra) => extra}
              onGenerate={handleAIGenerateAll}
              running={fillingAll}
              className="mb-3"
            />

            {/* 作品概览字段组：书名/简介/创意/文风/受众/意图 统一管理；编辑态下每项右侧常驻 ✦ 单项生成 */}
            <OverviewFieldRow
              label="书名"
              value={title}
              onChange={setTitle}
              filling={fillingField === 'title'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('title')}
              placeholder="书名（如：剑试天下）"
            />

            <OverviewFieldRow
              label="简介"
              value={description}
              onChange={setDescription}
              filling={fillingField === 'description'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('description')}
              textarea
              rows={3}
              placeholder="作品简介（可选），帮助 AI 更好地理解你的故事…"
            />

            <OverviewFieldRow
              label="创意"
              value={logline}
              onChange={setLogline}
              filling={fillingField === 'logline'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('logline')}
              textarea
              rows={2}
              placeholder="一句话创意（如：少年负剑出山，搅动江湖风云）"
            />
            <OverviewFieldRow
              label="文风"
              value={style}
              onChange={setStyle}
              filling={fillingField === 'style'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('style')}
              placeholder="文风（可选，如：冷峻武侠 / 轻松甜宠）"
            />
            <OverviewFieldRow
              label="受众"
              value={audience}
              onChange={setAudience}
              filling={fillingField === 'audience'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('audience')}
              placeholder="目标受众（可选，如：15-25 岁网文读者 / 都市女性）"
            />
            <OverviewFieldRow
              label="意图"
              value={intent}
              onChange={setIntent}
              filling={fillingField === 'intent'}
              busy={fillingField !== null || fillingAll}
              onAIFill={() => handleAIFillField('intent')}
              textarea
              rows={2}
              placeholder="创作意图（可选，如：爽文爽感优先 / 情感共鸣 / 悬疑反转）"
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
                {title.trim() ? `创建「${title.trim()}」并开启全本创作` : '创建作品并开启全本创作'}
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
