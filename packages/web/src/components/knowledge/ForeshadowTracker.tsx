import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Anchor,
  Plus,
  Loader2,
  ScanSearch,
  Wand2,
  Check,
  Trash2,
  MapPin,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { useForeshadowStore } from '@/stores/foreshadow-store';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore } from '@/stores/ui-store';
import { locateTextInEditor } from '@/stores/review-store';
import type { Foreshadow, ForeshadowStatus } from '@/services/foreshadow-client';
import { toast } from '@/components/common/Toast';

/**
 * 伏笔台账（业务方案 v3 E2，施工任务 A13）
 *
 * 分组：待回收（planted/reminded，按期望回收章节升序）/ 已回收 / 已废弃。
 * 埋设与回收章节均可点击跳转并高亮原文；AI 检测只给候选，登记与否由作者决定。
 */

const STATUS_META: Record<ForeshadowStatus, { label: string; dot: string }> = {
  planted: { label: '待回收', dot: 'bg-amber-400' },
  reminded: { label: '已提醒', dot: 'bg-orange-400' },
  resolved: { label: '已回收', dot: 'bg-emerald-400' },
  abandoned: { label: '已废弃', dot: 'bg-neutral-500' },
};

const ForeshadowTracker: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const chapters = useNovelStore((s) => s.chapters);
  const selectChapter = useNovelStore((s) => s.selectChapter);

  const {
    items,
    loading,
    detecting,
    scanning,
    candidates,
    degraded,
    error,
    load,
    create,
    adopt,
    setStatus,
    remove,
    detect,
    scan,
    clearCandidates,
    reset,
  } = useForeshadowStore();

  const [draft, setDraft] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  // 主动提示开关：提示条被关掉后，台账是重新开启的唯一入口
  const hintBarEnabled = useUIStore((s) => s.hintBarEnabled);
  const setHintBarEnabled = useUIStore((s) => s.setHintBarEnabled);

  const novelId = currentNovel?.id ?? null;

  useEffect(() => {
    if (novelId !== null) {
      void load(novelId);
    } else {
      reset();
    }
  }, [novelId, load, reset]);

  const groups = useMemo(() => {
    const pending = items
      .filter((f) => f.status === 'planted' || f.status === 'reminded')
      .sort(
        (a, b) =>
          (a.expect_chapter ?? Number.MAX_SAFE_INTEGER) -
          (b.expect_chapter ?? Number.MAX_SAFE_INTEGER),
      );
    const resolved = items.filter((f) => f.status === 'resolved');
    const abandoned = items.filter((f) => f.status === 'abandoned');
    return { pending, resolved, abandoned };
  }, [items]);

  /**
   * 跳转到某章节并高亮原文片段。
   *
   * 目标章节若不是当前章节，需先切换——编辑器为单实例换绑，必须等内容
   * 换绑完成再发定位事件，否则定位会落在新内容上（表现为"没反应"）。
   */
  const jumpTo = useCallback(
    async (chapterId: number, anchor?: string) => {
      const target = chapters.find((c) => c.id === chapterId);
      if (!target) {
        toast.show('章节不在当前作品的列表中', 'error');
        return;
      }
      if (currentChapter?.id !== chapterId) {
        await selectChapter(target);
        // 等编辑器完成内容换绑
        await new Promise((r) => setTimeout(r, 320));
      }
      if (anchor) locateTextInEditor(anchor);
    },
    [chapters, currentChapter, selectChapter],
  );

  const handleCreate = useCallback(async () => {
    const text = draft.trim();
    if (!text || novelId === null) return;
    const ok = await create(novelId, {
      description: text,
      ...(currentChapter ? { plant_chapter_id: currentChapter.id } : {}),
    });
    if (ok) {
      setDraft('');
      toast.show('已登记伏笔', 'success');
    }
  }, [draft, novelId, currentChapter, create]);

  const handleDetect = useCallback(async () => {
    if (novelId === null || !currentChapter) {
      toast.show('请先打开一个章节', 'error');
      return;
    }
    await detect(novelId, currentChapter.id);
  }, [novelId, currentChapter, detect]);

  const handleScan = useCallback(async () => {
    if (novelId === null || !currentChapter) {
      toast.show('请先打开一个章节', 'error');
      return;
    }
    const n = await scan(novelId, currentChapter.id);
    if (n > 0) {
      toast.show(`检测到 ${n} 条伏笔被本章回收`, 'success');
    } else {
      toast.show('本章未检测到伏笔回收', 'info');
    }
  }, [novelId, currentChapter, scan]);

  const handleAdopt = useCallback(
    async (candidateIndex: number) => {
      if (novelId === null) return;
      const c = candidates[candidateIndex];
      if (!c) return;
      const ok = await adopt(novelId, c, currentChapter?.id);
      if (ok) toast.show('已登记该伏笔', 'success');
    },
    [novelId, candidates, currentChapter, adopt],
  );

  const handleResolve = useCallback(
    async (f: Foreshadow) => {
      if (novelId === null) return;
      const ok = await setStatus(novelId, f.id, 'resolved', currentChapter?.id);
      if (ok) toast.show('已标记为回收', 'success');
    },
    [novelId, currentChapter, setStatus],
  );

  if (novelId === null) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-neutral-500 gap-2 px-6 text-center">
        <Anchor size={22} className="opacity-40" />
        <p className="text-xs">请先打开一部作品</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 顶部操作区 */}
      <div className="shrink-0 p-2.5 space-y-2 border-b border-white/6">
        <div className="flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="登记一条伏笔…"
            className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded-md bg-white/5 border border-white/8 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!draft.trim()}
            title="登记到当前章节"
            className="shrink-0 p-1.5 rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void handleDetect()}
            disabled={detecting}
            title="让 AI 找出当前章节埋下的伏笔（需逐条确认）"
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md bg-white/5 text-neutral-300 hover:bg-white/8 disabled:opacity-50 transition-colors"
          >
            {detecting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Wand2 size={12} />
            )}
            AI 检测本章伏笔
          </button>
          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={scanning}
            title="检查当前章节回收了哪些待办伏笔"
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md bg-white/5 text-neutral-300 hover:bg-white/8 disabled:opacity-50 transition-colors"
          >
            {scanning ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}
            检测回收
          </button>
        </div>

        <label className="flex items-center gap-1.5 px-0.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hintBarEnabled}
            onChange={(e) => setHintBarEnabled(e.target.checked)}
            className="w-3 h-3 rounded accent-brand-500 cursor-pointer"
          />
          <span className="text-[11px] text-neutral-400">写作时主动提醒未回收的伏笔</span>
        </label>

        {degraded && (
          <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>AI 服务不可用，以下为空是「没检测成」，不代表没有伏笔。</span>
          </div>
        )}
        {error && (
          <div className="px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20 text-[11px] text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* 候选区：AI 检测到的伏笔，待作者确认 */}
      {candidates.length > 0 && (
        <div className="shrink-0 max-h-[38%] overflow-y-auto p-2.5 border-b border-white/6 bg-brand-500/5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-brand-300">
              AI 候选（{candidates.length}）· 确认后才登记
            </span>
            <button
              type="button"
              onClick={clearCandidates}
              className="text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              清空
            </button>
          </div>
          <div className="space-y-1.5">
            {candidates.map((c, i) => (
              <div key={`${c.anchor}-${i}`} className="rounded-md bg-white/4 p-2">
                <p className="text-xs text-neutral-200 leading-snug">{c.description}</p>
                {c.anchor && (
                  <p className="text-[10px] text-neutral-500 mt-1 line-clamp-2">「{c.anchor}」</p>
                )}
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-neutral-500">
                    置信度 {Math.round(c.confidence * 100)}%
                  </span>
                  {c.expect_chapter !== undefined && (
                    <span className="text-[10px] text-neutral-500">
                      建议第 {c.expect_chapter} 章回收
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void handleAdopt(i)}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-brand-600/25 text-brand-300 hover:bg-brand-600/35 transition-colors"
                  >
                    <Check size={10} />
                    登记
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 分组列表 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-2.5">
        {loading && items.length === 0 && (
          <div className="py-8 flex justify-center">
            <Loader2 size={16} className="animate-spin text-neutral-500" />
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="py-8 text-center text-xs text-neutral-500 px-4">
            还没有登记任何伏笔。
            <br />
            可以直接输入，或让 AI 检测当前章节。
          </div>
        )}

        <Section title="待回收" count={groups.pending.length} accent="text-amber-300">
          {groups.pending.map((f) => (
            <Item
              key={f.id}
              f={f}
              onJump={jumpTo}
              onResolve={() => void handleResolve(f)}
              onAbandon={() => novelId !== null && void setStatus(novelId, f.id, 'abandoned')}
              onDelete={() => novelId !== null && void remove(novelId, f.id)}
            />
          ))}
        </Section>

        {(groups.resolved.length > 0 || showResolved) && (
          <Section
            title="已回收"
            count={groups.resolved.length}
            accent="text-emerald-300"
            collapsible
            collapsed={!showResolved}
            onToggle={() => setShowResolved((v) => !v)}
          >
            {groups.resolved.map((f) => (
              <Item
                key={f.id}
                f={f}
                onJump={jumpTo}
                onReopen={() => novelId !== null && void setStatus(novelId, f.id, 'planted')}
                onDelete={() => novelId !== null && void remove(novelId, f.id)}
              />
            ))}
          </Section>
        )}

        {groups.abandoned.length > 0 && (
          <Section title="已废弃" count={groups.abandoned.length} accent="text-neutral-400">
            {groups.abandoned.map((f) => (
              <Item
                key={f.id}
                f={f}
                onJump={jumpTo}
                onReopen={() => novelId !== null && void setStatus(novelId, f.id, 'planted')}
                onDelete={() => novelId !== null && void remove(novelId, f.id)}
              />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
};

/** 分组容器 */
const Section: React.FC<{
  title: string;
  count: number;
  accent: string;
  children: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}> = ({ title, count, accent, children, collapsible, collapsed, onToggle }) => {
  if (count === 0 && !collapsible) return null;
  const body = <div className="space-y-1.5">{children}</div>;
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={collapsible ? onToggle : undefined}
        className={`flex items-center gap-1.5 text-[11px] font-semibold mb-1.5 ${accent} ${
          collapsible ? 'hover:opacity-80' : 'cursor-default'
        }`}
      >
        {collapsible && (
          <ChevronRight
            size={11}
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
        )}
        {title}
        <span className="text-neutral-500 font-normal">{count}</span>
      </button>
      {!collapsed && body}
    </div>
  );
};

/** 单条伏笔 */
const Item: React.FC<{
  f: Foreshadow;
  onJump: (chapterId: number, anchor?: string) => void;
  onResolve?: () => void;
  onAbandon?: () => void;
  onReopen?: () => void;
  onDelete?: () => void;
}> = ({ f, onJump, onResolve, onAbandon, onReopen, onDelete }) => {
  const meta = STATUS_META[f.status];
  return (
    <div className="group rounded-lg bg-white/3 hover:bg-white/5 transition-colors p-2">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-neutral-200 leading-snug">{f.description}</p>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
            {f.plant_chapter_id !== undefined && (
              <button
                type="button"
                onClick={() => onJump(f.plant_chapter_id!, f.plant_anchor)}
                className="flex items-center gap-0.5 text-[10px] text-neutral-500 hover:text-brand-300 transition-colors"
                title="跳转到埋设位置"
              >
                <MapPin size={9} />
                {f.plant_chapter_title ?? `第${f.plant_chapter_id}章`}
              </button>
            )}
            {f.expect_chapter !== undefined && (
              <span className="text-[10px] text-neutral-600">期望第 {f.expect_chapter} 章</span>
            )}
            {f.resolve_chapter_id !== undefined && (
              <button
                type="button"
                onClick={() => onJump(f.resolve_chapter_id!)}
                className="flex items-center gap-0.5 text-[10px] text-emerald-500/80 hover:text-emerald-300 transition-colors"
                title="跳转到回收位置"
              >
                <Check size={9} />
                {f.resolve_chapter_title ?? `第${f.resolve_chapter_id}章`}
              </button>
            )}
            {f.source === 'ai' && (
              <span className="text-[10px] px-1 rounded bg-purple-500/15 text-purple-300">AI</span>
            )}
          </div>
        </div>
      </div>

      {/* 操作：hover 时才显形，避免列表视觉噪音 */}
      <div className="flex items-center justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {onReopen && (
          <button
            type="button"
            onClick={onReopen}
            className="px-1.5 py-0.5 text-[10px] rounded text-neutral-400 hover:bg-white/8 hover:text-neutral-200"
          >
            重新开启
          </button>
        )}
        {onResolve && (
          <button
            type="button"
            onClick={onResolve}
            className="px-1.5 py-0.5 text-[10px] rounded text-neutral-400 hover:bg-emerald-500/15 hover:text-emerald-300"
          >
            标记回收
          </button>
        )}
        {onAbandon && (
          <button
            type="button"
            onClick={onAbandon}
            className="px-1.5 py-0.5 text-[10px] rounded text-neutral-400 hover:bg-white/8 hover:text-neutral-200"
          >
            废弃
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="删除"
            className="p-0.5 rounded text-neutral-500 hover:bg-red-500/15 hover:text-red-300"
          >
            <Trash2 size={10} />
          </button>
        )}
      </div>
    </div>
  );
};

export default ForeshadowTracker;
