import React, { useEffect, useState } from 'react';
import { Activity, Loader2, MousePointerClick } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import {
  fetchServerRhythm,
  computeRhythm,
  type RhythmPoint,
} from '@/services/rhythm-client';

const W = 640;
const H = 200;
const PAD_X = 36;
const PAD_Y = 18;

/** 剧情节奏图：全书张力曲线，点击节点跳转到对应章节 */
const RhythmModal: React.FC = () => {
  const rhythmOpen = useUIStore((s) => s.rhythmOpen);
  const setRhythmOpen = useUIStore((s) => s.setRhythmOpen);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const selectChapter = useNovelStore((s) => s.selectChapter);

  const [points, setPoints] = useState<RhythmPoint[] | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!rhythmOpen) return;
    setPoints(null);
    let cancelled = false;
    (async () => {
      const serverScores = currentNovel ? await fetchServerRhythm(currentNovel.id) : null;
      if (cancelled) return;
      setPoints(computeRhythm(chapters, serverScores));
    })();
    return () => {
      cancelled = true;
    };
  }, [rhythmOpen, currentNovel?.id, chapters]);

  const close = () => setRhythmOpen(false);

  const jumpTo = (p: RhythmPoint) => {
    const chapter = chapters.find((c) => c.id === p.chapterId);
    if (chapter) {
      selectChapter(chapter);
      close();
    }
  };

  // 坐标映射
  const n = points?.length ?? 0;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD_X + (i / (n - 1)) * (W - PAD_X * 2));
  const y = (score: number) => H - PAD_Y - (score / 100) * (H - PAD_Y * 2);

  const path =
    points && n > 0
      ? points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ')
      : '';
  const area = n > 0 ? `${path} L ${x(n - 1).toFixed(1)} ${H - PAD_Y} L ${x(0).toFixed(1)} ${H - PAD_Y} Z` : '';

  return (
    <Modal open={rhythmOpen} onClose={close} title="剧情节奏图" width="700px">
      <div className="px-4 py-3">
        <p className="text-[11px] text-neutral-500 mb-3 flex items-center gap-1.5">
          <MousePointerClick size={12} />
          纵轴为章节张力强度（0-100），点击曲线节点跳转到对应章节
        </p>

        {!points ? (
          <div className="flex items-center justify-center gap-2 h-[200px] text-xs text-neutral-500">
            <Loader2 size={14} className="animate-spin text-brand-400" />
            正在分析全书节奏…
          </div>
        ) : n === 0 ? (
          <div className="flex flex-col items-center justify-center h-[200px] text-center">
            <Activity size={24} className="text-neutral-700 mb-2" />
            <p className="text-xs text-neutral-500">当前作品还没有章节</p>
          </div>
        ) : (
          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none">
              <defs>
                <linearGradient id="rhythm-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#818cf8" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id="rhythm-line" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="100%" stopColor="#f472b6" />
                </linearGradient>
              </defs>

              {/* 网格线 */}
              {[0, 25, 50, 75, 100].map((s) => (
                <g key={s}>
                  <line
                    x1={PAD_X}
                    x2={W - PAD_X}
                    y1={y(s)}
                    y2={y(s)}
                    stroke="rgba(255,255,255,0.06)"
                    strokeDasharray="3 4"
                  />
                  <text x={8} y={y(s) + 3} fill="rgba(255,255,255,0.25)" fontSize="8">
                    {s}
                  </text>
                </g>
              ))}

              <path d={area} fill="url(#rhythm-area)" />
              <path d={path} fill="none" stroke="url(#rhythm-line)" strokeWidth="2" strokeLinejoin="round" />

              {points.map((p, i) => (
                <g key={p.chapterId}>
                  <circle
                    cx={x(i)}
                    cy={y(p.score)}
                    r={hoverIdx === i ? 6 : 4}
                    fill={p.estimated ? '#181826' : '#818cf8'}
                    stroke={hoverIdx === i ? '#f472b6' : '#818cf8'}
                    strokeWidth="2"
                    className="cursor-pointer transition-all"
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
                    onClick={() => jumpTo(p)}
                  />
                  {(n <= 12 || i % Math.ceil(n / 12) === 0) && (
                    <text
                      x={x(i)}
                      y={H - 4}
                      fill="rgba(255,255,255,0.3)"
                      fontSize="8"
                      textAnchor="middle"
                    >
                      {i + 1}
                    </text>
                  )}
                </g>
              ))}
            </svg>

            {/* 悬浮提示 */}
            {hoverIdx !== null && points[hoverIdx] && (
              <div
                className="absolute pointer-events-none glass-panel rounded-lg px-2.5 py-1.5 text-[11px] z-10 animate-fade-in"
                style={{
                  left: `${(x(hoverIdx) / W) * 100}%`,
                  top: `${(y(points[hoverIdx].score) / H) * 100}%`,
                  transform: 'translate(-50%, -130%)',
                }}
              >
                <span className="text-neutral-200 font-medium">
                  第 {hoverIdx + 1} 章 · {points[hoverIdx].title}
                </span>
                <span className="ml-2 text-brand-300 tabular-nums">张力 {points[hoverIdx].score}</span>
                {points[hoverIdx].estimated && (
                  <span className="ml-2 text-neutral-500">本地估算</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* 章节清单（跳转指针） */}
        {points && n > 0 && (
          <div className="mt-3 max-h-[140px] overflow-y-auto rounded-lg border border-white/6">
            {points.map((p, i) => (
              <button
                key={p.chapterId}
                onClick={() => jumpTo(p)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 transition-colors border-b border-white/4 last:border-b-0"
              >
                <span className="text-[10px] text-neutral-600 w-5 tabular-nums">{i + 1}</span>
                <span className="flex-1 text-xs text-neutral-300 truncate">{p.title}</span>
                {p.estimated && <span className="text-[9px] text-neutral-600">估算</span>}
                <span className="w-24 h-1.5 rounded-full bg-white/6 overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-indigo-400 to-pink-400"
                    style={{ width: `${p.score}%` }}
                  />
                </span>
                <span className="text-[11px] text-neutral-400 tabular-nums w-7 text-right">{p.score}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default RhythmModal;
