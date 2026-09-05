import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Lightbulb, Loader2, MousePointerClick } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useStatsStore, calcStreak, todayKey } from '@/stores/stats-store';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/components/common/Toast';
import {
  fetchServerRhythm,
  computeRhythm,
  type RhythmPoint,
} from '@/services/rhythm-client';
import {
  fetchInspiration,
  INSPIRATION_LABELS,
  type InspirationCategory,
} from '@/services/ai-actions-client';

/**
 * 洞察面板（右侧板 Tab，备忘录 L61）：正文工具栏的剧情节奏 / 写作仪表盘 /
 * 灵感急救包三件套整体迁入，子视图内部切换。跳转章节 / 发送到 AI 助手等
 * 跨面板联动保持不变。
 */

type InsightView = 'rhythm' | 'dashboard' | 'inspiration';

const VIEW_META: { id: InsightView; label: string; icon: React.ReactNode }[] = [
  { id: 'rhythm', label: '剧情节奏', icon: <Activity size={12} /> },
  { id: 'dashboard', label: '仪表盘', icon: <BarChart3 size={12} /> },
  { id: 'inspiration', label: '灵感包', icon: <Lightbulb size={12} /> },
];

/** 洞察面板主体：三子视图切换（子视图受控于 ui-store，供命令面板深链） */
const InsightPanel: React.FC = () => {
  const view = useUIStore((s) => s.insightView);
  const setView = useUIStore((s) => s.setInsightView);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 子视图切换 */}
      <div className="flex items-center gap-1 px-3 pt-3 pb-2 sticky top-0 bg-surface-1 z-10">
        {VIEW_META.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-colors ${
              view === v.id
                ? 'bg-brand-600/25 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
            }`}
          >
            {v.icon}
            {v.label}
          </button>
        ))}
      </div>

      <div className="px-3 pb-4">
        {view === 'rhythm' && <RhythmView />}
        {view === 'dashboard' && <DashboardView />}
        {view === 'inspiration' && <InspirationView />}
      </div>
    </div>
  );
};

export default InsightPanel;

// ── 子视图 1：剧情节奏图 ─────────────────────────────────────────────
const W = 560;
const H = 190;
const PAD_X = 32;
const PAD_Y = 16;

const RhythmView: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const selectChapter = useNovelStore((s) => s.selectChapter);

  const [points, setPoints] = useState<RhythmPoint[] | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
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
  }, [currentNovel?.id, chapters]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = (p: RhythmPoint) => {
    const chapter = chapters.find((c) => c.id === p.chapterId);
    if (chapter) selectChapter(chapter);
  };

  const n = points?.length ?? 0;
  const x = (i: number) => (n <= 1 ? W / 2 : PAD_X + (i / (n - 1)) * (W - PAD_X * 2));
  const y = (score: number) => H - PAD_Y - (score / 100) * (H - PAD_Y * 2);
  const path =
    points && n > 0
      ? points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ')
      : '';
  const area = n > 0 ? `${path} L ${x(n - 1).toFixed(1)} ${H - PAD_Y} L ${x(0).toFixed(1)} ${H - PAD_Y} Z` : '';

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-neutral-500 flex items-center gap-1.5">
        <MousePointerClick size={12} />
        纵轴为章节张力强度（0-100），点击曲线节点跳转到对应章节
      </p>

      {!points ? (
        <div className="flex items-center justify-center gap-2 h-[180px] text-xs text-neutral-500">
          <Loader2 size={14} className="animate-spin text-brand-400" />
          正在分析全书节奏…
        </div>
      ) : n === 0 ? (
        <div className="flex flex-col items-center justify-center h-[180px] text-center">
          <Activity size={24} className="text-neutral-700 mb-2" />
          <p className="text-xs text-neutral-500">当前作品还没有章节</p>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none">
            <defs>
              <linearGradient id="rhythm-area-rt" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#818cf8" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#818cf8" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id="rhythm-line-rt" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#818cf8" />
                <stop offset="100%" stopColor="#f472b6" />
              </linearGradient>
            </defs>
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
                <text x={6} y={y(s) + 3} fill="rgba(255,255,255,0.25)" fontSize="8">
                  {s}
                </text>
              </g>
            ))}
            <path d={area} fill="url(#rhythm-area-rt)" />
            <path d={path} fill="none" stroke="url(#rhythm-line-rt)" strokeWidth="2" strokeLinejoin="round" />
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
                  <text x={x(i)} y={H - 4} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="middle">
                    {i + 1}
                  </text>
                )}
              </g>
            ))}
          </svg>

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
              {points[hoverIdx].estimated && <span className="ml-2 text-neutral-500">本地估算</span>}
            </div>
          )}
        </div>
      )}

      {points && n > 0 && (
        <div className="max-h-[160px] overflow-y-auto rounded-lg border border-white/6">
          {points.map((p, i) => (
            <button
              key={p.chapterId}
              onClick={() => jumpTo(p)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 transition-colors border-b border-white/4 last:border-b-0"
            >
              <span className="text-[10px] text-neutral-600 w-5 tabular-nums">{i + 1}</span>
              <span className="flex-1 text-xs text-neutral-300 truncate">{p.title}</span>
              {p.estimated && <span className="text-[9px] text-neutral-600">估算</span>}
              <span className="w-20 h-1.5 rounded-full bg-white/6 overflow-hidden">
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
  );
};

// ── 子视图 2：写作仪表盘 ─────────────────────────────────────────────
const WEEKS = 12;
const DAY_MS = 24 * 3600 * 1000;

function buildHeatmapDays(): string[][] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // 周一=0
  const thisMonday = new Date(today.getTime() - dow * DAY_MS);
  const cols: string[][] = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    const col: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(thisMonday.getTime() - w * 7 * DAY_MS + d * DAY_MS);
      if (day.getTime() > today.getTime()) break;
      const m = `${day.getMonth() + 1}`.padStart(2, '0');
      const dd = `${day.getDate()}`.padStart(2, '0');
      col.push(`${day.getFullYear()}-${m}-${dd}`);
    }
    cols.push(col);
  }
  return cols;
}

function heatColor(words: number, goal: number): string {
  if (words <= 0) return 'rgba(255,255,255,0.05)';
  const ratio = Math.min(1, words / goal);
  if (ratio < 0.25) return 'rgba(99,102,241,0.3)';
  if (ratio < 0.5) return 'rgba(99,102,241,0.55)';
  if (ratio < 1) return 'rgba(99,102,241,0.8)';
  return '#818cf8';
}

const DashboardView: React.FC = () => {
  const { daily, dailyGoal, setDailyGoal } = useStatsStore();
  const [goalDraft, setGoalDraft] = useState<string | null>(null);

  const cols = useMemo(buildHeatmapDays, []); // eslint-disable-line react-hooks/exhaustive-deps

  const today = daily[todayKey()] ?? 0;
  const streak = calcStreak(daily);
  const totalWords = Object.values(daily).reduce((a, b) => a + b, 0);
  const activeDays = Object.values(daily).filter((v) => v > 0).length;

  const R = 34;
  const C = 2 * Math.PI * R;
  const progress = Math.min(1, today / dailyGoal);

  const statCards = [
    { label: '连更天数', value: `${streak} 天` },
    { label: '累计写作', value: `${totalWords.toLocaleString()} 字` },
    { label: '写作天数', value: `${activeDays} 天` },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-xl bg-white/3 border border-white/6 p-2 flex flex-col items-center justify-center">
          <div className="relative w-[64px] h-[64px]">
            <svg viewBox="0 0 84 84" className="w-full h-full -rotate-90">
              <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
              <circle
                cx="42"
                cy="42"
                r={R}
                fill="none"
                stroke="url(#dash-ring-rt)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - progress)}
                className="transition-all duration-500"
              />
              <defs>
                <linearGradient id="dash-ring-rt" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="100%" stopColor="#f472b6" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-sm font-semibold text-neutral-100 tabular-nums">
                {Math.round(progress * 100)}%
              </span>
              <span className="text-[9px] text-neutral-500">今日目标</span>
            </div>
          </div>
          <div className="mt-1 text-[10px] text-neutral-500 tabular-nums">{today.toLocaleString()} 字</div>
        </div>

        {statCards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl bg-white/3 border border-white/6 p-2 flex flex-col items-center justify-center gap-1"
          >
            <span className="text-sm font-semibold text-neutral-100 tabular-nums">{c.value}</span>
            <span className="text-[10px] text-neutral-500">{c.label}</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-white/3 border border-white/6 p-3">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs text-neutral-300 font-medium">近 {WEEKS} 周写作热力</span>
          <div className="flex items-center gap-1 text-[10px] text-neutral-500">
            少
            {[0, 0.25, 0.5, 0.75, 1].map((r) => (
              <span
                key={r}
                className="w-2.5 h-2.5 rounded-[3px]"
                style={{ background: r === 0 ? 'rgba(255,255,255,0.05)' : `rgba(99,102,241,${0.3 + r * 0.5})` }}
              />
            ))}
            多
          </div>
        </div>
        <div className="flex gap-[3px] overflow-x-auto pb-1">
          {cols.map((col, i) => (
            <div key={i} className="flex flex-col gap-[3px]">
              {col.map((day) => (
                <div
                  key={day}
                  title={`${day} · ${(daily[day] ?? 0).toLocaleString()} 字`}
                  className="w-3 h-3 rounded-[3px] transition-transform hover:scale-125 cursor-default"
                  style={{ background: heatColor(daily[day] ?? 0, dailyGoal) }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <BarChart3 size={13} className="text-neutral-500" />
        <span>每日字数目标</span>
        {goalDraft === null ? (
          <button
            onClick={() => setGoalDraft(String(dailyGoal))}
            className="px-2 py-0.5 rounded-md bg-white/6 text-neutral-200 hover:bg-white/10 tabular-nums transition-colors"
          >
            {dailyGoal.toLocaleString()} 字
          </button>
        ) : (
          <>
            <input
              type="number"
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = parseInt(goalDraft, 10);
                  if (!isNaN(v)) setDailyGoal(v);
                  setGoalDraft(null);
                }
              }}
              autoFocus
              className="w-24 rounded-md bg-white/6 border border-brand-500/40 px-2 py-0.5 text-neutral-100 outline-none tabular-nums"
            />
            <button
              onClick={() => {
                const v = parseInt(goalDraft, 10);
                if (!isNaN(v)) setDailyGoal(v);
                setGoalDraft(null);
              }}
              className="px-2 py-0.5 rounded-md bg-brand-600 text-white hover:bg-brand-500 transition-colors"
            >
              保存
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// ── 子视图 3：灵感急救包 ─────────────────────────────────────────────
const CATEGORIES = Object.keys(INSPIRATION_LABELS) as InspirationCategory[];

const InspirationView: React.FC = () => {
  const [category, setCategory] = useState<InspirationCategory>('plot');
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async (cat: InspirationCategory) => {
    setLoading(true);
    try {
      const result = await fetchInspiration(cat);
      setItems(result);
    } catch {
      setItems([]);
      toast.show('灵感获取失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(category);
  }, [category]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show('已复制灵感', 'success');
    } catch {
      toast.show('复制失败', 'error');
    }
  };

  /** 发送到 AI 助手展开讨论 */
  const handleSendToChat = (text: string) => {
    window.dispatchEvent(
      new CustomEvent('inkbloom:chat-draft', { detail: { text: `请围绕这个点子展开：${text}` } }),
    );
    toast.show('已发送到 AI 助手', 'success');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
              category === c
                ? 'bg-brand-600/25 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
            }`}
          >
            {INSPIRATION_LABELS[c]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {loading && (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-neutral-500">
            <Loader2 size={13} className="animate-spin text-brand-400" />
            正在召唤灵感…
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Lightbulb size={24} className="text-neutral-700 mb-2" />
            <p className="text-xs text-neutral-500">暂时没有灵感，点上方分类换一批</p>
          </div>
        )}

        {!loading &&
          items.map((item, i) => (
            <div
              key={i}
              className="group rounded-lg border border-white/8 bg-white/3 hover:border-amber-500/40 hover:bg-amber-500/5 px-3 py-2.5 transition-all animate-fade-in"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-start gap-2">
                <Lightbulb size={14} className="shrink-0 mt-0.5 text-amber-400" />
                <p className="flex-1 text-[13px] text-neutral-200 leading-relaxed">{item}</p>
              </div>
              <div className="flex justify-end gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleCopy(item)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-white/8 transition-colors"
                >
                  复制
                </button>
                <button
                  onClick={() => handleSendToChat(item)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-brand-300 hover:bg-brand-500/15 transition-colors"
                >
                  让 AI 展开
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
};

