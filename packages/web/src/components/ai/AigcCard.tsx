import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles, Square, ChevronDown, ChevronUp, Check } from 'lucide-react';
import type { AgentScene } from '@/services/agent-client';
import { agentGenerate, generatePortraitImage } from '@/services/agent-client';
import { useTaskStore } from '@/stores/task-store';
import { useNovelStore } from '@/stores/novel-store';
import { toast } from '@/components/common/Toast';
import {
  useAigcClues,
  currentChapterExcerpt,
  nearbyChaptersExcerpt,
  type AigcClueExcerpts,
} from '@/hooks/useAigcClues';

/**
 * 统一 AIGC 配置卡片（备忘录 L61）——全项目 AI 生成交互的唯一入口形态：
 *
 *  · 多态：不同 scene 跑不同 Agent 工作流（character/setting/summary/
 *    inspiration/outline/chapter），默认为基于线索库的带格式文本生成；
 *    mode='image' 走立绘图片任务链路。
 *  · 可选上下文注入：架构 / 大纲 / 记忆默认勾选，悬念 / 本章正文 / 附近章节
 *    可选。大纲/记忆/悬念由服务端按开关装配（记忆门控始终在服务端求值，
 *    记忆库 AIGC 可见性优先不绕过）；架构/本章正文/附近章节为客户端摘录，
 *    确认时拼接进指令（【参考上下文】块）。
 *  · 点击 AIGC → 展开与右侧板同风格的附加指令对话框：输入**可选**（拼接为
 *    附加内容）、不带技能选择、可直接确认；确认后对话框收起。
 *  · 生成中按钮切换为「取消」（AbortController 真中断），同时推送右侧任务
 *    通知（本地伪任务，type=aigc_<scene>，终态自动销毁）。
 *
 * 产物经 onApply 交给宿主（填表单 / 覆盖正文 / 插入光标 / 追加关系…）。
 */

export type AigcClueKind =
  | 'architecture'
  | 'outline'
  | 'memory'
  | 'foreshadow'
  | 'current_chapter'
  | 'nearby_chapters';

/** 确认时交给宿主的上下文快照（宿主管线用，如全本概览生成） */
export interface AigcClueContext {
  selected: AigcClueKind[];
  excerpts: Partial<Record<AigcClueKind, string>>;
}

const CLUE_META: { kind: AigcClueKind; label: string }[] = [
  { kind: 'architecture', label: '架构' },
  { kind: 'outline', label: '大纲' },
  { kind: 'memory', label: '记忆' },
  { kind: 'foreshadow', label: '悬念' },
  { kind: 'current_chapter', label: '本章正文' },
  { kind: 'nearby_chapters', label: '附近章节' },
];

/** 默认勾选：架构、大纲、记忆（备忘录 L61） */
const DEFAULT_SELECTED: AigcClueKind[] = ['architecture', 'outline', 'memory'];

export interface AigcCardProps {
  novelId?: number;
  scene: AgentScene;
  /** 任务面板展示名，默认 `AIGC · ${scene}` */
  taskLabel?: string;
  /** 组装最终指令：extra = 用户附加指令（可为空串，可选输入） */
  buildInstruction: (extra: string) => string;
  itemId?: string;
  nodeId?: string;
  /** 文本/图片工作流产物的宿主回调（宿主自管工作流 onGenerate 模式下可省略） */
  onApply?: (content: string) => void;
  /** 图片工作流（立绘）：mode='image' 走既有 AIGC 图片任务链路 */
  mode?: 'text' | 'image';
  /** 宿主自管工作流（如成章走 DraftPreviewModal 预览确认链路）：传入后内置
   *  管线（请求/任务登记/取消）关闭，任务通知与取消由宿主管线负责；
   *  ctx 为勾选的上下文快照（含各线索摘录） */
  onGenerate?: (instruction: string, ctx: AigcClueContext) => void;
  /** 受控运行态（配合 onGenerate；缺省走卡片内置运行态） */
  running?: boolean;
  /** 隐藏上下文注入行（如立绘图片卡、无作品上下文的随记/自媒体卡） */
  disableContext?: boolean;
  /** 卡片说明（折叠态展示） */
  hint?: string;
  /** 折叠态默认收起 */
  defaultOpen?: boolean;
  className?: string;
}

const AigcCard: React.FC<AigcCardProps> = ({
  novelId,
  scene,
  taskLabel,
  buildInstruction,
  itemId,
  nodeId,
  onApply,
  mode = 'text',
  onGenerate,
  running: runningProp,
  disableContext = false,
  hint,
  defaultOpen = false,
  className = '',
}) => {
  const hostMode = onGenerate !== undefined;
  const [open, setOpen] = useState(defaultOpen);
  const [selfRunning, setSelfRunning] = useState(false);
  const running = hostMode ? (runningProp ?? false) : selfRunning;
  const [extra, setExtra] = useState('');
  const [selected, setSelected] = useState<Set<AigcClueKind>>(new Set(DEFAULT_SELECTED));
  const abortRef = useRef<AbortController | null>(null);
  const taskIdRef = useRef<string | null>(null);

  const clueExcerpts = useAigcClues(novelId);
  const hasChapter = useNovelStore((s) => !!s.currentChapter);
  const label = taskLabel ?? `AIGC · ${scene}`;

  /** 上下文行可见性：宿主未禁用且存在任何可注入来源 */
  const showContext = !disableContext && mode === 'text' && !!(novelId || hasChapter);

  /** 单类线索当前摘录（库类来自缓存，章类现取） */
  const excerptFor = useCallback(
    (kind: AigcClueKind, lib: AigcClueExcerpts | null): string => {
      switch (kind) {
        case 'architecture':
          return lib?.architecture ?? '';
        case 'outline':
          return lib?.outline ?? '';
        case 'memory':
          return lib?.memory ?? '';
        case 'foreshadow':
          return lib?.foreshadow ?? '';
        case 'current_chapter':
          return currentChapterExcerpt();
        case 'nearby_chapters':
          return nearbyChaptersExcerpt();
      }
    },
    [],
  );

  /** 确认时刻的上下文快照：勾选且非空的线索 */
  const assembleContext = useCallback((): AigcClueContext => {
    const excerpts: Partial<Record<AigcClueKind, string>> = {};
    const picked: AigcClueKind[] = [];
    for (const kind of selected) {
      const text = excerptFor(kind, clueExcerpts);
      if (text.trim()) {
        picked.push(kind);
        excerpts[kind] = text;
      }
    }
    return { selected: picked, excerpts };
  }, [selected, clueExcerpts, excerptFor]);

  /** 客户端摘录拼接块（架构/本章/附近；大纲/记忆/悬念走服务端开关，不重复拼接） */
  const buildClientContextBlock = useCallback((ctx: AigcClueContext): string => {
    const labels: Partial<Record<AigcClueKind, string>> = {
      architecture: '架构',
      current_chapter: '本章正文',
      nearby_chapters: '附近章节',
    };
    const parts: string[] = [];
    for (const kind of ['architecture', 'current_chapter', 'nearby_chapters'] as AigcClueKind[]) {
      const text = ctx.excerpts[kind];
      if (text && labels[kind]) parts.push(`【${labels[kind]}】${text}`);
    }
    return parts.length ? `\n\n【参考上下文】\n${parts.join('\n')}` : '';
  }, []);

  /** 结束本地伪任务并复位按钮 */
  const finish = useCallback((status: 'success' | 'failed' | 'cancelled', errorMsg = '') => {
    if (taskIdRef.current) {
      useTaskStore.getState().update(taskIdRef.current, { status, error_msg: errorMsg });
      taskIdRef.current = null;
    }
    setSelfRunning(false);
    abortRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    finish('cancelled');
    toast.show('已取消生成', 'info');
  }, [finish]);

  const run = useCallback(
    async (instruction: string) => {
      const ctx = assembleContext();
      // 客户端摘录块（架构/本章正文/附近章节）拼接进最终指令；
      // 宿主管线同样收到拼接后的指令（宿主若使用 ctx 结构化线索则以 ctx 为准）。
      const finalInstruction = `${instruction}${buildClientContextBlock(ctx)}`;
      // 宿主自管工作流：内置管线不启动（任务/取消/请求由宿主负责）
      if (hostMode) {
        onGenerate(finalInstruction, ctx);
        return;
      }
      setSelfRunning(true);
      const taskId = crypto.randomUUID();
      taskIdRef.current = taskId;
      useTaskStore.getState().register({
        id: taskId,
        type: `aigc_${scene}`,
        status: 'running',
        progress: 8,
        novel_id: novelId ?? null,
        local: true,
      });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        if (mode === 'image') {
          const res = await generatePortraitImage(instruction, novelId ?? 0);
          if (ctrl.signal.aborted) return;
          finish('success');
          onApply?.(res.url);
        } else {
          const res = await agentGenerate(
            {
              novel_id: novelId ?? 0,
              scene,
              item_id: itemId,
              node_id: nodeId,
              instruction: finalInstruction,
              // 服务端上下文开关：大纲/记忆/悬念（勾选=注入，缺省全量）
              context: {
                outline: selected.has('outline'),
                memory: selected.has('memory'),
                foreshadow: selected.has('foreshadow'),
              },
            },
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          finish('success');
          onApply?.(res.content);
        }
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
          finish('cancelled');
          return;
        }
        const msg = e instanceof Error ? e.message : '生成失败，请稍后重试';
        finish('failed', msg);
        toast.show(`${label}失败：${msg}`, 'error');
      }
    },
    [
      assembleContext,
      hostMode,
      onGenerate,
      buildClientContextBlock,
      mode,
      novelId,
      scene,
      itemId,
      nodeId,
      onApply,
      finish,
      label,
      selected,
    ],
  );

  /** 确认生成：对话框收起 → 按 buildInstruction(可选附加指令) + 上下文跑工作流 */
  const handleConfirm = useCallback(() => {
    setOpen(false);
    void run(buildInstruction(extra.trim()));
  }, [buildInstruction, extra, run]);

  const toggleClue = useCallback((kind: AigcClueKind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const chipElems = useMemo(
    () =>
      CLUE_META.map(({ kind, label: clueLabel }) => {
        const available =
          kind === 'current_chapter'
            ? hasChapter && !!currentChapterExcerpt()
            : kind === 'nearby_chapters'
              ? hasChapter && !!nearbyChaptersExcerpt()
              : !!clueExcerpts?.[kind];
        const on = selected.has(kind);
        return (
          <button
            key={kind}
            type="button"
            disabled={!available}
            onClick={() => toggleClue(kind)}
            title={
              available
                ? on
                  ? `已勾选：生成将参考${clueLabel}上下文`
                  : `勾选后生成将参考${clueLabel}上下文`
                : clueExcerpts
                  ? `暂无${clueLabel}内容`
                  : '线索加载中…'
            }
            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-all ${
              on
                ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                : available
                  ? 'bg-white/4 text-neutral-500 border-white/8 hover:bg-white/10 hover:text-neutral-300'
                  : 'bg-white/3 text-neutral-600 border-white/6 cursor-not-allowed opacity-60'
            }`}
          >
            {on && <Check size={9} className="text-emerald-300" />}
            {clueLabel}
          </button>
        );
      }),
    [clueExcerpts, selected, toggleClue, hasChapter],
  );

  return (
    <div
      className={`rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/6 px-3 py-2 ${className}`}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-fuchsia-300 shrink-0" />
        <span className="text-xs font-semibold text-fuchsia-200">AIGC</span>
        <span className="text-[10px] text-neutral-500 truncate">{hint ?? label}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => (running ? handleCancel() : setOpen((v) => !v))}
          disabled={running}
          title={running ? '生成中…' : '展开 AIGC 配置'}
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-40 transition-colors"
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {running && !hostMode ? (
          <button
            type="button"
            onClick={handleCancel}
            title="取消生成"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-200 bg-amber-600/25 hover:bg-amber-600/35 transition-colors"
          >
            <Square size={11} />
            取消
          </button>
        ) : !running ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 transition-all shadow-lg shadow-fuchsia-600/20"
          >
            <Sparkles size={12} />
            AIGC
          </button>
        ) : null}
      </div>

      {/* 可选上下文注入（备忘录 L61）：默认勾选架构/大纲/记忆；悬念/本章/附近可选。
          大纲/记忆/悬念由服务端按开关装配（记忆门控在服务端求值）；
          架构/本章正文/附近章节为客户端摘录，确认时拼接进指令。 */}
      {showContext && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          <span className="text-[10px] text-neutral-600 shrink-0">上下文</span>
          {chipElems}
        </div>
      )}

      {/* 附加指令对话框：与右侧板 AI 助手输入同风格；可选输入，确认后收起 */}
      {open && !running && (
        <div className="mt-2 pt-2 border-t border-white/8">
          <textarea
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            rows={2}
            autoFocus
            placeholder={`附加指令（可选）：留空则按「${label}」默认工作流生成，输入内容将拼接为附加要求`}
            className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-2 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-fuchsia-500/50 resize-none"
          />
          <div className="flex items-center justify-end gap-2 mt-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setExtra('');
              }}
              className="px-3 py-1 rounded-md text-[11px] text-neutral-400 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium text-white bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 transition-colors"
            >
              <Sparkles size={10} />
              确认生成
            </button>
          </div>
        </div>
      )}

      {/* 生成中横条 */}
      {running && (
        <div className="mt-2 flex items-center gap-2 pt-2 border-t border-white/8 text-[11px] text-neutral-400">
          <Loader2 size={11} className="animate-spin text-fuchsia-300" />
          {label} 生成中…（可取消，任务同步到右侧任务栏）
        </div>
      )}
    </div>
  );
};

export default AigcCard;
