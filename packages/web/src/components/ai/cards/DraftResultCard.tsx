import React, { useState } from 'react';
import { Play, Check, RefreshCw, Trash2, Loader2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { useAIStore } from '@/stores/ai-store';
import {
  STORY_STAGE_LABELS,
  generateStoryStage,
  advanceStoryStage,
  adoptStoryChapter,
  deleteStoryJob,
} from '@/services/story-client';
import type { StoryJob } from '@/services/story-client';
import { toast } from '@/components/common/Toast';
import { confirmDialog } from '@/components/common/ConfirmDialog';
import CardShell from './CardShell';
import type { DraftResultCard as DraftResultCardData, DraftIssueSummary } from '@/types';

interface DraftResultCardProps {
  messageId: string;
  card: DraftResultCardData;
}

type BusyAction = 'next' | 'adopt' | 'regen' | 'retry' | 'abandon';

/** 从 generate/adopt 端点返回的 job 快照中抽取 verify 阶段的一致性 issue 摘要 */
function issuesOf(job: StoryJob): { issues: DraftIssueSummary[]; count: number } {
  const raw = job.stage_payload?.issues ?? [];
  const issues = (raw as { description?: string; entity?: string }[]).map((it) => ({
    description: it.description,
    entity: it.entity,
  }));
  return { issues, count: job.stage_payload?.issue_count ?? issues.length };
}

/**
 * 起稿结果卡片（P0-4/P0-6）：配置卡确认后原地替换而来。
 * 所有按钮操作都通过 updateCardMessage 在原消息上就地更新（不追加新消息），
 * 卡片自持加载态，不触碰 story-store 的全局 generating/adopting flag。
 */
const DraftResultCard: React.FC<DraftResultCardProps> = ({ messageId, card }) => {
  const updateCardMessage = useAIStore((s) => s.updateCardMessage);
  const notifyAgentContext = useAIStore((s) => s.notifyAgentContext);

  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [expanded, setExpanded] = useState(false);

  const stageLabel = STORY_STAGE_LABELS[card.stage] ?? card.stage;
  const isVerify = card.stage === 'verify';
  const hasContent = !!card.content;
  const lastStage = card.stage === 'done';
  const terminal = card.status === 'abandoned';
  const actionsDisabled = busy !== null || terminal;

  /** verify 阶段判定（供 applyJob 与渲染共用） */
  const isVerifyJob = (job: StoryJob) => job.stage === 'verify';

  /** 用 generate/adopt 返回的 job 快照原地更新卡片（保留采纳记录等本地态） */
  const applyJob = (job: StoryJob) => {
    updateCardMessage(messageId, (c) => {
      if (c.kind !== 'draft_result') return c;
      const { issues, count } = issuesOf(job);
      return {
        ...c,
        status: job.status === 'failed' ? 'failed' : 'ready',
        stage: job.stage,
        content: (job.stage_payload?.content as string) || undefined,
        issues: isVerifyJob(job) ? issues : undefined,
        issueCount: isVerifyJob(job) ? count : undefined,
        chapterKeys: job.chapter_keys,
        jobStatus: job.status,
        error: job.last_error || undefined,
      };
    });
  };


  /** 生成下一阶段 / 重新生成当前阶段（同一端点） */
  const handleGenerate = async (action: 'next' | 'regen' | 'retry') => {
    setBusy(action);
    updateCardMessage(messageId, (c) =>
      c.kind === 'draft_result' ? { ...c, status: 'running', error: undefined } : c,
    );
    try {
      const generated = await generateStoryStage(card.jobId);
      // 「生成下一阶段」= 生成当前阶段产物后，再推进到下一阶段（对齐旧面板「生成当前阶段 + 下一阶段」两步）。
      // 「重新生成 / 重试」仅重新生成当前阶段、停在原地。
      const job = action === 'next' ? await advanceStoryStage(card.jobId) : generated;
      applyJob(job);
      notifyAgentContext(`「${card.title}」的${STORY_STAGE_LABELS[job.stage]}阶段已生成`);
    } catch (e) {
      console.error('generate stage failed', e);
      updateCardMessage(messageId, (c) =>
        c.kind === 'draft_result'
          ? {
              ...c,
              status: 'failed',
              jobStatus: 'failed',
              error: e instanceof Error ? e.message : '生成失败，请重试',
            }
          : c,
      );
      toast.show('生成失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 采纳到章节：空 key 由服务端幂等生成 ch-{n+1}，重复点击不产生重复章节 */
  const handleAdopt = async () => {
    if (!card.content) return;
    setBusy('adopt');
    try {
      const job = await adoptStoryChapter(card.jobId, {
        chapter_key: '',
        title: `第 ${(card.chapterKeys ?? 0) + 1} 章`,
        content: card.content,
      });
      const adopted = job.stage_payload?.adopted ?? [];
      const adoptedKey = adopted[adopted.length - 1]?.chapter_key;
      updateCardMessage(messageId, (c) =>
        c.kind === 'draft_result'
          ? {
              ...c,
              status: 'adopted',
              adoptedKey: adoptedKey || c.adoptedKey,
              chapterKeys: job.chapter_keys,
              jobStatus: job.status,
            }
          : c,
      );
      notifyAgentContext(`「${card.title}」的一章已采纳到章节列表`);
      toast.show('已采纳到章节', 'success');
    } catch (e) {
      console.error('adopt chapter failed', e);
      toast.show(e instanceof Error ? e.message : '采纳失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 放弃：删除 job，卡片进入灰化终态（不影响已采纳的章节） */
  const handleAbandon = async () => {
    if (
      !(await confirmDialog({
        title: '放弃创作任务',
        message: '确定放弃该创作任务？（不影响已采纳的章节）',
        confirmText: '放弃',
        danger: true,
      }))
    )
      return;
    setBusy('abandon');
    try {
      await deleteStoryJob(card.jobId);
      updateCardMessage(messageId, (c) =>
        c.kind === 'draft_result' ? { ...c, status: 'abandoned' } : c,
      );
      notifyAgentContext(`「${card.title}」的创作任务已放弃`);
    } catch (e) {
      console.error('delete job failed', e);
      toast.show('放弃任务失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  };

  const badge =
    card.status === 'failed'
      ? { text: '失败', tone: 'red' as const }
      : card.status === 'abandoned'
        ? { text: '已放弃', tone: 'gray' as const }
        : card.status === 'adopted'
          ? { text: '已采纳', tone: 'green' as const }
          : card.status === 'running'
            ? { text: '生成中', tone: 'violet' as const }
            : { text: stageLabel, tone: 'violet' as const };

  return (
    <CardShell title={`AI 起稿 · ${card.title}`} icon={<Play size={13} />} badge={badge}>
      {/* 灰化终态 */}
      {terminal ? (
        <p className="text-xs text-neutral-500 py-2">该创作任务已放弃，已采纳的章节不受影响。</p>
      ) : (
        <>
          {/* 进行中态：spinner + 当前阶段文案 */}
          {card.status === 'running' && (
            <div className="flex items-center gap-2 py-3 text-xs text-neutral-400">
              <Loader2 size={14} className="animate-spin text-violet-400" />
              正在生成：{stageLabel}…
            </div>
          )}

          {/* 失败态：错误摘要 + 重试/放弃 */}
          {card.status === 'failed' && (
            <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-2">
              <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
              <span className="text-xs text-red-300 break-words">{card.error || '生成失败，请重试'}</span>
            </div>
          )}

          {/* verify 阶段：一致性报告摘要（issue 列表），无正文 */}
          {card.status !== 'running' && isVerify && (
            <div className="mb-2">
              <p className="text-xs font-medium text-neutral-300 mb-1.5">一致性校验报告</p>
              {(card.issueCount ?? 0) === 0 ? (
                <p className="text-sm text-emerald-400">✓ 未发现一致性冲突</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {(card.issues ?? []).map((it, i) => (
                    <div
                      key={i}
                      className="text-xs text-neutral-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-2"
                    >
                      {it.description || JSON.stringify(it)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 阶段产物正文预览（默认折叠） */}
          {card.status !== 'running' && hasContent && (
            <div>
              <div
                className={`text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap break-words ${
                  expanded ? '' : 'max-h-40 overflow-hidden'
                }`}
              >
                {card.content}
              </div>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-violet-400 hover:text-violet-300"
              >
                {expanded ? (
                  <>
                    收起 <ChevronUp size={11} />
                  </>
                ) : (
                  <>
                    展开全文 <ChevronDown size={11} />
                  </>
                )}
              </button>
            </div>
          )}

          {/* 按钮组（按 stage/status 条件渲染） */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {!lastStage && card.status !== 'failed' && (
              <button
                onClick={() => handleGenerate('next')}
                disabled={actionsDisabled}
                className="px-3 py-1.5 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 text-xs font-medium transition-all disabled:opacity-40"
              >
                {busy === 'next' ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <Play size={12} className="inline mr-1" />}
                {busy === 'next' ? '生成中…' : '生成下一阶段'}
              </button>
            )}

            {hasContent && card.status !== 'adopted' && (
              <button
                onClick={handleAdopt}
                disabled={actionsDisabled}
                className="px-3 py-1.5 rounded-lg bg-fuchsia-600/20 hover:bg-fuchsia-600/30 text-fuchsia-300 text-xs font-medium transition-all disabled:opacity-40"
              >
                {busy === 'adopt' ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <Check size={12} className="inline mr-1" />}
                {busy === 'adopt' ? '采纳中…' : '采纳到章节'}
              </button>
            )}
            {card.status === 'adopted' && (
              <button
                disabled
                className="px-3 py-1.5 rounded-lg bg-emerald-600/15 text-emerald-300 text-xs font-medium cursor-not-allowed"
              >
                <Check size={12} className="inline mr-1" />
                已采纳 ✓
              </button>
            )}

            {card.status === 'failed' && (
              <button
                onClick={() => handleGenerate('retry')}
                disabled={actionsDisabled}
                className="px-3 py-1.5 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 text-xs font-medium transition-all disabled:opacity-40"
              >
                {busy === 'retry' ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <RefreshCw size={12} className="inline mr-1" />}
                重试
              </button>
            )}

            {!lastStage && card.status !== 'failed' && (
              <button
                onClick={() => handleGenerate('regen')}
                disabled={actionsDisabled}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium transition-all disabled:opacity-40"
              >
                {busy === 'regen' ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <RefreshCw size={12} className="inline mr-1" />}
                {busy === 'regen' ? '重新生成中…' : '重新生成'}
              </button>
            )}

            <button
              onClick={handleAbandon}
              disabled={actionsDisabled}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-500/10 hover:text-red-300 text-neutral-400 text-xs font-medium transition-all disabled:opacity-40"
            >
              {busy === 'abandon' ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <Trash2 size={12} className="inline mr-1" />}
              放弃
            </button>
          </div>
        </>
      )}
    </CardShell>
  );
};

export default DraftResultCard;
