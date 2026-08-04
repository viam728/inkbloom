import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 写作统计：按天记录新增字数，用于仪表盘热力图 / 连更 / 目标 */
interface StatsState {
  /** key: yyyy-MM-dd, value: 当日新增字数 */
  daily: Record<string, number>;
  /** 每日字数目标 */
  dailyGoal: number;

  addWords: (count: number) => void;
  setDailyGoal: (goal: number) => void;
}

export const todayKey = () => {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

export const useStatsStore = create<StatsState>()(
  persist(
    (set) => ({
      daily: {},
      dailyGoal: 1000,

      addWords: (count) => {
        if (count <= 0) return;
        const key = todayKey();
        set((s) => ({
          daily: { ...s.daily, [key]: (s.daily[key] ?? 0) + count },
        }));
      },

      setDailyGoal: (goal) => set({ dailyGoal: Math.max(100, goal) }),
    }),
    { name: 'inkbloom-stats' },
  ),
);

/** 计算连续写作天数（含今天，若今天未写则从昨天算起） */
export function calcStreak(daily: Record<string, number>): number {
  let streak = 0;
  const cursor = new Date();
  const has = (d: Date) => {
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return (daily[`${d.getFullYear()}-${m}-${day}`] ?? 0) > 0;
  };
  // 今天未写不打断连更，从昨天开始数
  if (!has(cursor)) cursor.setDate(cursor.getDate() - 1);
  while (has(cursor)) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
