import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 阅读器偏好与状态（业务方案 v3 E4，施工任务 A19）
 *
 * 用独立 persist key `inkbloom-reader`，不动 ui-store 的 partialize——
 * 阅读器是独立子系统，偏好也独立持久化更干净。字号/主题/行距是读者
 * 的个人偏好，跨会话保持；当前章节与滚动位置是会话态，不持久化。
 */
export type ReaderTheme = 'dark' | 'sepia' | 'light';

interface ReaderState {
  // ── 持久化偏好 ──
  fontSize: number; // px，16–22
  lineHeight: number; // 倍数，1.6–2.2
  theme: ReaderTheme;
  // ── 会话态（不持久化）──
  currentSlug: string | null;
  currentChapterId: number | null;

  setFontSize: (n: number) => void;
  setLineHeight: (n: number) => void;
  setTheme: (t: ReaderTheme) => void;
  setSession: (slug: string | null, chapterId: number | null) => void;
}

export const useReaderStore = create<ReaderState>()(
  persist(
    (set) => ({
      fontSize: 18,
      lineHeight: 1.85,
      theme: 'dark',
      currentSlug: null,
      currentChapterId: null,

      setFontSize: (n) => set({ fontSize: Math.max(14, Math.min(24, n)) }),
      setLineHeight: (n) => set({ lineHeight: Math.max(1.5, Math.min(2.4, n)) }),
      setTheme: (t) => set({ theme: t }),
      setSession: (slug, chapterId) =>
        set({ currentSlug: slug, currentChapterId: chapterId }),
    }),
    {
      name: 'inkbloom-reader',
      // 会话态不持久化：只有偏好跨会话保留
      partialize: (s) => ({
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        theme: s.theme,
      }),
    },
  ),
);
