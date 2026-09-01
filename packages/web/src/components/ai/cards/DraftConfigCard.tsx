import React, { useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { useAIStore } from '@/stores/ai-store';
import { createStoryJob, generateStoryStage } from '@/services/story-client';
import { toast } from '@/components/common/Toast';
import CardShell from './CardShell';
import type { DraftConfigCard as DraftConfigCardData } from '@/types';

interface DraftConfigCardProps {
  messageId: string; // 用于 updateCardMessage 原地替换
  card: DraftConfigCardData;
}

/**
 * 起稿配置卡片（P0-2）：点 skill「AI 起稿」插入对话流。
 * 确认后直调 createStoryJob，成功即原地替换为 DraftResultCard 并继续
 * generateStoryStage；失败保留 editing 态可重试。
 * 滑动条规格与旧面板一致：章节数 3–50 默认 10；每章字数 500–5000 step 100 默认 2000。
 */
const DraftConfigCard: React.FC<DraftConfigCardProps> = ({ messageId, card }) => {
  const updateCardMessage = useAIStore((s) => s.updateCardMessage);

  const [title, setTitle] = useState(card.title);
  const [logline, setLogline] = useState(card.logline);
  const [chapterCount, setChapterCount] = useState(card.config.chapter_count);
  const [wordsPerChapter, setWordsPerChapter] = useState(card.config.words_per_chapter);
  const [style, setStyle] = useState(card.config.style);
  const [autoSettle, setAutoSettle] = useState(card.config.auto_settle);
  const [submitting, setSubmitting] = useState(false);

  const noNovel = !card.novelId;
  const canSubmit = !noNovel && !!title.trim() && !!logline.trim() && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const job = await createStoryJob({
        novel_id: card.novelId,
        title: title.trim(),
        logline: logline.trim(),
        config: { chapter_count: chapterCount, words_per_chapter: wordsPerChapter, style, auto_settle: autoSettle },
      });
      // Q6 原地替换为结果卡（running 态），随后立刻驱动第一阶段生成
      updateCardMessage(messageId, (c) =>
        c.kind === 'draft_config'
          ? {
              kind: 'draft_result',
              jobId: job.id,
              novelId: job.novel_id,
              title: job.title,
              status: 'running',
              stage: job.stage,
              jobStatus: job.status,
              chapterKeys: job.chapter_keys,
            }
          : c,
      );
      const generated = await generateStoryStage(job.id);
      updateCardMessage(messageId, (c) =>
        c.kind === 'draft_result'
          ? {
              ...c,
              status: 'ready',
              stage: generated.stage,
              content: (generated.stage_payload?.content as string) || undefined,
              jobStatus: generated.status,
              error: generated.last_error || undefined,
            }
          : c,
      );
    } catch (e) {
      console.error('start story draft failed', e);
      toast.show(e instanceof Error ? e.message : '创建创作任务失败，请重试', 'error');
      // 卡片保留 editing 态，可修改参数后重试
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CardShell title="AI 起稿 · 配置" icon={<Wand2 size={14} />}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="作品名（如：剑试天下）"
        disabled={submitting}
        className="w-full mb-2 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 disabled:opacity-50"
      />
      <textarea
        value={logline}
        onChange={(e) => setLogline(e.target.value)}
        placeholder="一句话创意（如：少年负剑出山，搅动江湖风云）"
        rows={2}
        disabled={submitting}
        className="w-full mb-2 px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 resize-none disabled:opacity-50"
      />

      {/* 生成设置（滑动条规格与旧面板一致） */}
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
          disabled={submitting}
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
          disabled={submitting}
          onChange={(e) => setWordsPerChapter(Number(e.target.value))}
          className="w-full accent-violet-500"
        />
        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="文风（可选，如：冷峻武侠 / 轻松甜宠）"
          disabled={submitting}
          className="w-full mt-2 px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500"
        />
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={autoSettle}
            disabled={submitting}
            onChange={(e) => setAutoSettle(e.target.checked)}
            className="accent-violet-500"
          />
          <span className="text-[11px] text-neutral-400">采纳后自动沉淀设定/角色/图谱/伏笔</span>
        </label>
      </div>

      {noNovel ? (
        <div className="text-center py-3 px-2 rounded-lg bg-white/3 border border-dashed border-white/10">
          <p className="text-xs text-neutral-400 mb-1">起稿需要先选定一部作品</p>
          <p className="text-[11px] text-neutral-600">请在左侧「作品」列表中选择或新建一部作品，再回来起稿</p>
        </div>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-2 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium transition-all disabled:opacity-40 disabled:hover:from-violet-600 disabled:hover:to-fuchsia-600"
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="inline mr-1.5 animate-spin" />
              创建中…
            </>
          ) : (
            <>
              <Wand2 size={14} className="inline mr-1.5" />
              开始起稿
            </>
          )}
        </button>
      )}
    </CardShell>
  );
};

export default DraftConfigCard;
