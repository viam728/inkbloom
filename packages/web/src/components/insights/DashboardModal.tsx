import React, { useMemo, useState } from 'react';
import { BarChart3, Flame, Target, PenLine, Trophy } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useUIStore } from '@/stores/ui-store';
import { useStatsStore, calcStreak, todayKey } from '@/stores/stats-store';

const WEEKS = 12;
const DAY_MS = 24 * 3600 * 1000;

/** 生成近 N 周的日期 key 矩阵（列=周，行=周一到周日） */
function buildHeatmapDays(): string[][] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 找到本周周一
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

/** 写作仪表盘：热力图 / 今日目标环 / 连更 / 总量 */
const DashboardModal: React.FC = () => {
  const dashboardOpen = useUIStore((s) => s.dashboardOpen);
  const setDashboardOpen = useUIStore((s) => s.setDashboardOpen);
  const { daily, dailyGoal, setDailyGoal } = useStatsStore();
  const [goalDraft, setGoalDraft] = useState<string | null>(null);

  const cols = useMemo(buildHeatmapDays, [dashboardOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = daily[todayKey()] ?? 0;
  const streak = calcStreak(daily);
  const totalWords = Object.values(daily).reduce((a, b) => a + b, 0);
  const activeDays = Object.values(daily).filter((v) => v > 0).length;

  // 目标环
  const R = 34;
  const C = 2 * Math.PI * R;
  const progress = Math.min(1, today / dailyGoal);

  const close = () => setDashboardOpen(false);

  const statCards = [
    {
      icon: <Flame size={15} className="text-orange-400" />,
      label: '连更天数',
      value: `${streak} 天`,
    },
    {
      icon: <PenLine size={15} className="text-brand-400" />,
      label: '累计写作',
      value: `${totalWords.toLocaleString()} 字`,
    },
    {
      icon: <Trophy size={15} className="text-amber-400" />,
      label: '写作天数',
      value: `${activeDays} 天`,
    },
  ];

  return (
    <Modal open={dashboardOpen} onClose={close} title="写作仪表盘" width="560px">
      <div className="px-4 py-4">
        {/* 顶部统计卡 */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {/* 今日目标环 */}
          <div className="rounded-xl bg-white/3 border border-white/6 p-3 flex flex-col items-center justify-center">
            <div className="relative w-[76px] h-[76px]">
              <svg viewBox="0 0 84 84" className="w-full h-full -rotate-90">
                <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
                <circle
                  cx="42"
                  cy="42"
                  r={R}
                  fill="none"
                  stroke="url(#dash-ring)"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - progress)}
                  className="transition-all duration-500"
                />
                <defs>
                  <linearGradient id="dash-ring" x1="0" y1="0" x2="1" y2="1">
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
            <div className="mt-1 flex items-center gap-1 text-[10px] text-neutral-500">
              <Target size={10} />
              <span className="tabular-nums">{today.toLocaleString()} 字</span>
            </div>
          </div>

          {statCards.map((c) => (
            <div key={c.label} className="rounded-xl bg-white/3 border border-white/6 p-3 flex flex-col items-center justify-center gap-1.5">
              {c.icon}
              <span className="text-sm font-semibold text-neutral-100 tabular-nums">{c.value}</span>
              <span className="text-[10px] text-neutral-500">{c.label}</span>
            </div>
          ))}
        </div>

        {/* 热力图 */}
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

        {/* 目标设置 */}
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
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
    </Modal>
  );
};

export default DashboardModal;
