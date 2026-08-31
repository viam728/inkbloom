import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Flower2, Search, BookOpen, Users, FileText, Sparkles, Loader2, PenLine } from 'lucide-react';
import { discoverWorks } from '@/services/reader-client';
import { useAuthStore } from '@/stores/auth-store';
import type { DiscoverWork } from '@/types/published';

const PAGE_SIZE = 24;

/** 作品封面：有 cover_url 用图，否则渐变占位 + 书名首字 */
const Cover: React.FC<{ work: DiscoverWork }> = ({ work }) => {
  if (work.cover_url) {
    return (
      <img
        src={work.cover_url}
        alt={work.title}
        className="w-full h-40 object-cover"
        loading="lazy"
      />
    );
  }
  const palette = [
    'from-indigo-500 to-purple-600',
    'from-pink-500 to-rose-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
  ];
  const idx = work.id % palette.length;
  return (
    <div
      className={`w-full h-40 bg-gradient-to-br ${palette[idx]} flex items-center justify-center`}
    >
      <span className="text-3xl font-bold text-white/90">{work.title.slice(0, 1) || '书'}</span>
    </div>
  );
};

/**
 * 发现页 / 社区首页：公开作品的浏览入口（飞轮起点）。
 * 匿名可访问，登录用户也能从这里逛社区再回到创作工作台。
 */
const DiscoverPage: React.FC = () => {
  const status = useAuthStore((s) => s.status);
  const [works, setWorks] = useState<DiscoverWork[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (query: string, reset: boolean) => {
    const offset = reset ? 0 : offsetRef.current;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    try {
      const rows = await discoverWorks(query, PAGE_SIZE, offset);
      setWorks((prev) => (reset ? rows : [...prev, ...rows]));
      offsetRef.current = offset + rows.length;
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      /* 失败静默，保留已有内容 */
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load('', true);
  }, [load]);

  const onSearch = (value: string) => {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      offsetRef.current = 0;
      load(value, true);
    }, 300);
  };

  const goWork = (slug: string) => {
    window.location.href = `/read/${slug}`;
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-surface-0 text-neutral-100">
      {/* 氛围背景 */}
      <div aria-hidden className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-32 w-[560px] h-[560px] rounded-full bg-brand-600/16 blur-[130px]" />
        <div className="absolute -bottom-48 right-[8%] w-[520px] h-[520px] rounded-full bg-pink-600/10 blur-[140px]" />
      </div>

      <div className="relative max-w-6xl mx-auto px-6 pb-16">
        {/* 顶部导航 */}
        <header className="sticky top-0 z-10 flex items-center justify-between py-4 bg-surface-0/80 backdrop-blur">
          <a href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <Flower2 size={17} className="text-white" />
            </div>
            <span className="font-display text-lg font-bold bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
              InkBloom 社区
            </span>
          </a>
          <a
            href="/"
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium text-neutral-300 border border-white/10 bg-white/4 hover:bg-white/8 hover:text-neutral-100 transition-colors"
          >
            <PenLine size={13} />
            {status === 'authed' ? '回到工作台' : '开始创作'}
          </a>
        </header>

        {/* 搜索 */}
        <div className="mt-6 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/4 border border-white/8 focus-within:border-brand-500/40">
          <Search size={15} className="text-neutral-500 shrink-0" />
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索作品标题…"
            className="flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
          />
        </div>

        {/* 作品列表 */}
        {loading && works.length === 0 ? (
          <div className="flex justify-center py-24">
            <Loader2 size={22} className="animate-spin text-neutral-500" />
          </div>
        ) : works.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-neutral-500">
            <BookOpen size={28} className="opacity-40" />
            <p className="text-sm">还没有公开作品，来当第一个发布的人</p>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {works.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => goWork(w.slug)}
                  className="group text-left rounded-xl overflow-hidden bg-white/4 border border-white/8 hover:border-brand-500/40 hover:bg-white/6 transition-colors"
                >
                  <div className="relative">
                    <Cover work={w} />
                    {w.ai_inspired && (
                      <span className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-[9px] text-amber-300">
                        <Sparkles size={9} /> AI 辅助
                      </span>
                    )}
                  </div>
                  <div className="p-3 space-y-1.5">
                    <p className="text-sm font-medium text-neutral-100 truncate">{w.title}</p>
                    <p className="text-[11px] text-neutral-500 truncate">by {w.author_name}</p>
                    <p className="text-[11px] text-neutral-400 leading-relaxed line-clamp-2">
                      {w.synopsis || '暂无简介'}
                    </p>
                    <div className="flex items-center gap-3 pt-1 text-[10px] text-neutral-500">
                      <span className="flex items-center gap-1">
                        <Users size={11} /> {w.follow_count}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileText size={11} /> {w.chapter_count} 章
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {hasMore && (
              <div className="flex justify-center mt-8">
                <button
                  type="button"
                  onClick={() => load(q, false)}
                  disabled={loadingMore}
                  className="px-5 py-2 rounded-lg text-xs font-medium text-neutral-300 border border-white/10 bg-white/4 hover:bg-white/8 disabled:opacity-50 transition-colors"
                >
                  {loadingMore ? <Loader2 size={14} className="animate-spin" /> : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default DiscoverPage;
