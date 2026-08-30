import React, { useEffect, useState } from 'react';
import { Loader2, BookOpen } from 'lucide-react';
import type { PublicWork, PublicChapterSummary, PublicChapter } from '@/types/published';
import { getPublicWork, listPublicChapters, getPublicChapter, getReadingProgress } from '@/services/reader-client';
import { useAuthStore } from '@/stores/auth-store';
import ChapterReader from './ChapterReader';

interface ReaderPageProps {
  slug: string;
  /** 路由来的章节 id（字符串），可选 */
  chapterId?: string;
}

/**
 * 公开阅读页顶层容器（业务方案 v3 E4，施工任务 A19）
 *
 * 路由匹配在 App.tsx 的 IIFE 里（C8：无 react-router），命中 /read/:slug[/:pid]
 * 即渲染本组件。章节切换沿用整页刷新（window.location.href），与 LegalPage
 * 先例一致——加 popstate 等于引入第二套路由真相。
 *
 * 首章选择：登录用户尝试续读位置，否则第一章。游客的续读位置存在
 * localStorage（由 ChapterReader 写入），这里也读取兜底。
 */
const ReaderPage: React.FC<ReaderPageProps> = ({ slug, chapterId }) => {
  const status = useAuthStore((s) => s.status);
  const [work, setWork] = useState<PublicWork | null>(null);
  const [chapters, setChapters] = useState<PublicChapterSummary[]>([]);
  const [chapter, setChapter] = useState<PublicChapter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载作品 + 章节列表
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [w, list] = await Promise.all([getPublicWork(slug), listPublicChapters(slug)]);
        if (cancelled) return;
        if (list.length === 0) {
          setError('这部作品还没有发布的章节');
          setLoading(false);
          return;
        }
        setWork(w);
        setChapters(list);

        // 决定首章：路由指定 > 续读位置 > 第一章
        let targetPid: number | undefined;
        if (chapterId) {
          targetPid = Number(chapterId);
        } else {
          // 登录用户的服务端续读
          if (status === 'authed') {
            const p = await getReadingProgress(w.id).catch(() => null);
            if (p && list.some((c) => c.id === p.chapter_id)) {
              targetPid = p.chapter_id;
            }
          }
          // 游客的本地续读
          if (targetPid === undefined) {
            try {
              const local = localStorage.getItem(`reader-progress:${w.id}`);
              if (local) {
                const lp = JSON.parse(local);
                if (list.some((c) => c.id === lp.chapter_id)) targetPid = lp.chapter_id;
              }
            } catch {
              /* 忽略 */
            }
          }
          if (targetPid === undefined) targetPid = list[0].id;
        }

        const ch = await getPublicChapter(targetPid).catch(() => null);
        if (cancelled) return;
        if (!ch) {
          // 指定的章节不可见（可能定时未到点），回退第一章
          const fallback = await getPublicChapter(list[0].id).catch(() => null);
          if (cancelled) return;
          setChapter(fallback);
        } else {
          setChapter(ch);
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '作品不存在或未公开');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // chapterId 变化时重新加载对应章节（整页刷新场景下组件重建，这里主要是 slug 变化）
  }, [slug, chapterId, status]);

  const navigate = (pid: number) => {
    // 整页刷新：与现有无-router 架构一致
    window.location.href = `/read/${slug}/${pid}`;
  };

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-surface-0">
        <Loader2 size={24} className="animate-spin text-neutral-500" />
      </div>
    );
  }

  if (error || !work || !chapter) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-surface-0 text-neutral-400 gap-3">
        <BookOpen size={28} className="opacity-40" />
        <p className="text-sm">{error ?? '作品不存在'}</p>
        <a href="/" className="text-xs text-brand-400 hover:text-brand-300">回到首页</a>
      </div>
    );
  }

  return <ChapterReader chapter={chapter} chapters={chapters} workId={work.id} slug={slug} onNavigate={navigate} />;
};

export default ReaderPage;
