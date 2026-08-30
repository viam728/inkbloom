import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, AlertTriangle, Info, X } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import { useReviewStore } from '@/stores/review-store';
import { fetchHints, type ForeshadowHint } from '@/services/foreshadow-client';

/**
 * 写作侧边主动提示条（业务方案 v3 E2，施工任务 A15）
 *
 * 常驻编辑器顶部的细条，**无提示时返回 null（不占任何版面）**。
 *
 * 优先级：超期伏笔 > 本章未处理的 error 级批注 > 临近回收的伏笔。
 * 只展示最高优先级的一条——同时弹三条的话，作者会全部忽略。
 *
 * 一致性问题复用 review-store 的既有结果，不额外调 AI：评审本身是
 * 作者手动触发的昂贵操作，提示条只负责"别忘了看已有的问题"。
 */
const REFRESH_THROTTLE_MS = 300_000; // 5 分钟内不重复请求

/** 提示条要展示的内容：伏笔提示，或本章未处理的一致性问题 */
type BarContent =
  | { kind: 'hint'; hint: ForeshadowHint }
  | { kind: 'issue'; count: number };

const ForeshadowHintBar: React.FC = () => {
  const enabled = useUIStore((s) => s.hintBarEnabled);
  const setHintBarEnabled = useUIStore((s) => s.setHintBarEnabled);
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab);

  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);

  // 已有评审结果（可能为空数组：作者还没跑过批注评审）
  const annotations = useReviewStore((s) => s.annotations);
  const reviewedChapterId = useReviewStore((s) => s.reviewedChapterId);

  const [hints, setHints] = useState<ForeshadowHint[]>([]);
  /** 章节 → 上次请求时间，用于 5 分钟节流 */
  const lastFetchRef = useRef<Record<string, number>>({});

  const novelId = currentNovel?.id;
  const chapterId = currentChapter?.id;

  const load = useCallback(
    async (force: boolean) => {
      if (novelId === undefined || chapterId === undefined) {
        setHints([]);
        return;
      }
      const key = `${novelId}:${chapterId}`;
      const now = Date.now();
      if (!force && now - (lastFetchRef.current[key] ?? 0) < REFRESH_THROTTLE_MS) {
        return;
      }
      lastFetchRef.current[key] = now;
      try {
        setHints(await fetchHints(novelId, chapterId));
      } catch {
        setHints([]); // 提示失败不该显示成"一切正常"
      }
    },
    [novelId, chapterId],
  );

  // 切换章节时拉取（受节流保护）
  useEffect(() => {
    if (!enabled) {
      setHints([]);
      return;
    }
    void load(false);
  }, [enabled, load]);

  // 章节保存后强制刷新一次：作者刚写完，超期状态可能刚发生变化
  useEffect(() => {
    const onSaved = () => {
      if (enabled) void load(true);
    };
    window.addEventListener('inkbloom:chapter-saved', onSaved);
    return () => window.removeEventListener('inkbloom:chapter-saved', onSaved);
  }, [enabled, load]);

  /** 本章未处理的 error 级批注数（仅当评审过本章才有意义） */
  const issueCount = useMemo(() => {
    if (reviewedChapterId !== chapterId) return 0;
    return annotations.filter((a) => a.severity === 'issue' && !a.resolved).length;
  }, [annotations, reviewedChapterId, chapterId]);

  const overdue = hints.find((h) => h.type === 'overdue');
  const upcoming = hints.find((h) => h.type === 'upcoming');

  // 按优先级挑出唯一要展示的那条。做成 tagged union 而不是让字符串和
  // hint 对象混在一个变量里，渲染分支就能被类型系统检查到。
  const top: BarContent | null =
    overdue !== undefined
      ? { kind: 'hint', hint: overdue }
      : issueCount > 0
        ? { kind: 'issue', count: issueCount }
        : upcoming !== undefined
          ? { kind: 'hint', hint: upcoming }
          : null;

  const openTracker = useCallback(() => {
    setActiveRightTab('tracker');
  }, [setActiveRightTab]);

  // 无提示 → 完全不渲染，把版面还给编辑器
  if (!enabled || top === null) return null;

  const isIssue = top.kind === 'issue';
  const warn = !isIssue && top.hint.severity === 'warn';

  return (
    <div
      className={`shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs border-b ${
        isIssue
          ? 'bg-red-500/8 border-red-500/20 text-red-300'
          : warn
            ? 'bg-amber-500/10 border-amber-500/20 text-amber-200'
            : 'bg-sky-500/8 border-sky-500/20 text-sky-200'
      }`}
    >
      {isIssue || warn ? (
        <AlertTriangle size={13} className="shrink-0" />
      ) : (
        <Info size={13} className="shrink-0" />
      )}

      <span className="flex-1 min-w-0 truncate">
        {top.kind === 'issue'
          ? `本章有 ${top.count} 处待处理的一致性问题`
          : top.hint.message}
      </span>

      {top.kind === 'issue' ? (
        <button
          type="button"
          onClick={() => setActiveRightTab('review')}
          className="shrink-0 px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 transition-colors"
        >
          查看批注
        </button>
      ) : (
        <button
          type="button"
          onClick={openTracker}
          className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 transition-colors"
          title="打开伏笔台账"
        >
          <Anchor size={11} />
          去处理
        </button>
      )}

      <button
        type="button"
        onClick={() => setHintBarEnabled(false)}
        title="关闭主动提示（可在伏笔台账顶部重新开启）"
        className="shrink-0 p-0.5 rounded hover:bg-white/15 transition-colors opacity-60 hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
};

export default ForeshadowHintBar;
