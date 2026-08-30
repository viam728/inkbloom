import React, { useEffect, useState } from 'react';
import { Users, Eye, Loader2 } from 'lucide-react';
import { getWorkStats } from '@/services/reader-client';
import type { WorkStats } from '@/types/published';

/**
 * 作者侧读者数据面板（业务方案 v3 E4 数据回流，施工任务 A23）。
 *
 * 展示追更人数、累计阅读人数、以及「每章当前阅读人数」的漏斗——由于
 * reading_progress 只存每个读者最后的位置，这里每章人数 = 读者最后一次
 * 停留点，是对「读完率 / 跳出」最诚实的近似。
 */
const WorkStatsPanel: React.FC<{ workId: number }> = ({ workId }) => {
  const [stats, setStats] = useState<WorkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const maxReaders = Math.max(1, ...stats.chapters.map((c) => c.reader_count));

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

      {/* 每章阅读漏斗 */}
      {stats.chapters.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-neutral-500">每章当前阅读人数</p>
          {stats.chapters.map((c) => (
            <div key={c.chapter_id} className="flex items-center gap-2">
              <span className="text-[11px] text-neutral-400 w-20 truncate shrink-0">
                第{c.position}章
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-white/6 overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand-500/70"
                  style={{ width: `${(c.reader_count / maxReaders) * 100}%` }}
                />
              </div>
              <span className="text-[11px] text-neutral-300 w-6 text-right shrink-0">
                {c.reader_count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkStatsPanel;
