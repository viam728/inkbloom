import React, { useCallback, useEffect, useState } from 'react';
import { Users, Eye, Loader2, ChevronRight } from 'lucide-react';
import { getWorkStats, getChapterEmotions } from '@/services/reader-client';
import type { WorkStats, ChapterEmotions } from '@/types/published';

/** 情绪元数据（与后端 model.Mood* 一致）：键、emoji、曲线颜色 */
const MOOD_META: { key: string; emoji: string; label: string; color: string }[] = [
  { key: 'fire', emoji: '🔥', label: '燃', color: '#f97316' },
  { key: 'knife', emoji: '💔', label: '刀', color: '#ef4444' },
  { key: 'sweet', emoji: '🍬', label: '甜', color: '#ec4899' },
  { key: 'mystery', emoji: '❓', label: '谜', color: '#a855f7' },
];

/** 章节情绪曲线：按 block_index 绘制四种情绪的折线 */
const EmotionCurve: React.FC<{ emotions: ChapterEmotions }> = ({ emotions }) => {
  const W = 280;
  const H = 72;
  const PAD = 6;
  const blocks = emotions.blocks;
  const maxCount = Math.max(
    1,
    ...blocks.flatMap((b) => Object.values(b.moods)),
    ...Object.values(emotions.totals),
  );
  // X 轴按 block_index 的先后顺序等距分布（有情绪的段才有数据点）
  const xs = blocks.map((_, i) =>
    blocks.length <= 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (blocks.length - 1),
  );
  const yOf = (n: number) => H - PAD - (n / maxCount) * (H - PAD * 2);

  return (
    <div className="space-y-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[72px]" preserveAspectRatio="none">
        {MOOD_META.map((m) => {
          const pts = blocks
            .map((b, i) => {
              const n = b.moods[m.key] ?? 0;
              return `${xs[i]},${yOf(n)}`;
            })
            .join(' ');
          if (!pts) return null;
          return (
            <polyline
              key={m.key}
              points={pts}
              fill="none"
              stroke={m.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.9}
            />
          );
        })}
        {/* 数据点 */}
        {blocks.map((b, i) =>
          MOOD_META.filter((m) => (b.moods[m.key] ?? 0) > 0).map((m) => (
            <circle key={`${i}-${m.key}`} cx={xs[i]} cy={yOf(b.moods[m.key] ?? 0)} r={2} fill={m.color} />
          )),
        )}
      </svg>
      <div className="flex items-center gap-2 flex-wrap">
        {MOOD_META.filter((m) => (emotions.totals[m.key] ?? 0) > 0).map((m) => (
          <span
            key={m.key}
            className="flex items-center gap-1 text-[10px] text-neutral-400"
          >
            <span className="w-2 h-2 rounded-full" style={{ background: m.color }} />
            {m.emoji} {m.label} ×{emotions.totals[m.key] ?? 0}
          </span>
        ))}
        {Object.keys(emotions.totals).length === 0 && (
          <span className="text-[10px] text-neutral-600">本章暂无情绪反馈</span>
        )}
      </div>
    </div>
  );
};

/**
 * 作者侧读者数据面板（业务方案 v3 E4 数据回流 A23 + E5 情绪曲线 A31）。
 *
 * 顶部指标：追更人数、累计阅读人数。下方为每章阅读漏斗；点击章节行展开
 * 该章的「情绪曲线」（读者在段落上点的燃/刀/甜/谜分布）。
 */
const WorkStatsPanel: React.FC<{ workId: number }> = ({ workId }) => {
  const [stats, setStats] = useState<WorkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 展开的章节 + 情绪数据缓存
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [emotions, setEmotions] = useState<Record<number, ChapterEmotions>>({});
  const [emotionLoading, setEmotionLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWorkStats(workId)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workId]);

  const toggleExpand = useCallback(
    async (pid: number) => {
      if (expandedPid === pid) {
        setExpandedPid(null);
        return;
      }
      setExpandedPid(pid);
      if (!emotions[pid]) {
        setEmotionLoading(true);
        try {
          const data = await getChapterEmotions(pid);
          setEmotions((prev) => ({ ...prev, [pid]: data }));
        } catch {
          /* 情绪加载失败不阻断 */
        } finally {
          setEmotionLoading(false);
        }
      }
    },
    [expandedPid, emotions],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={14} className="animate-spin text-neutral-500" />
      </div>
    );
  }

  if (error || !stats) {
    return <p className="text-[11px] text-neutral-500 text-center py-3">暂无读者数据</p>;
  }

  return (
    <div className="space-y-3">
      {/* 顶部指标卡 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white/4 border border-white/6">
          <Users size={14} className="text-brand-300 shrink-0" />
          <div>
            <p className="text-[10px] text-neutral-500">追更人数</p>
            <p className="text-sm font-semibold text-neutral-100">{stats.follow_count}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white/4 border border-white/6">
          <Eye size={14} className="text-emerald-300 shrink-0" />
          <div>
            <p className="text-[10px] text-neutral-500">阅读人数</p>
            <p className="text-sm font-semibold text-neutral-100">{stats.reader_count}</p>
          </div>
        </div>
      </div>

      {/* 每章阅读漏斗 + 情绪曲线 */}
      {stats.chapters.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-neutral-500">每章阅读人数（点击展开情绪曲线）</p>
          {stats.chapters.map((c, idx) => {
            const expanded = expandedPid === c.chapter_id;
            return (
              <div key={c.chapter_id} className="rounded-lg bg-white/3 border border-white/5">
                <button
                  type="button"
                  onClick={() => void toggleExpand(c.chapter_id)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/4 transition-colors rounded-lg"
                >
                  <ChevronRight
                    size={12}
                    className={`text-neutral-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] text-neutral-400 w-14 truncate shrink-0">
                    第{idx + 1}章
                  </span>
                  <span className="flex-1 min-w-0 text-[11px] text-neutral-300 truncate text-left">
                    {c.title}
                  </span>
                  <span className="text-[11px] text-neutral-300 w-6 text-right shrink-0">
                    {c.reader_count}
                  </span>
                </button>
                {expanded && (
                  <div className="px-3 pb-3 pt-1">
                    {emotionLoading && !emotions[c.chapter_id] ? (
                      <div className="flex justify-center py-3">
                        <Loader2 size={13} className="animate-spin text-neutral-500" />
                      </div>
                    ) : emotions[c.chapter_id] ? (
                      <EmotionCurve emotions={emotions[c.chapter_id]} />
                    ) : (
                      <p className="text-[10px] text-neutral-600 text-center py-2">加载失败</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WorkStatsPanel;
