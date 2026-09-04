import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Send, CheckCircle2, ExternalLink, Globe, Link2, Lock, ImagePlus, RotateCcw } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useOutlineStore, sortChaptersByOutline, type OutlineStatus } from '@/stores/outline-store';
import { usePublishStore } from '@/stores/publish-store';
import {
  publishWork,
  publishChapter,
  unpublishChapter,
} from '@/services/reader-client';
import { uploadImage } from '@/services/image-client';
import { track } from '@/services/analytics';
import { toast } from '@/components/common/Toast';

/**
 * 作者侧发布弹窗（业务方案 v3 E4，施工任务 A20）
 *
 * 两阶段：
 *  1. 作品未发布 → 填写标题/简介/可见性，创建 PublishedWork
 *  2. 作品已发布 → 勾选章节发布（立即或定时），展示阅读链接
 *
 * 已发布章节以 published_chapters 表为系统事实（publish-store 缓存）：
 * 列表内打「已发布」标并可取消发布；重新发布=更新读者侧快照。
 * 发布/取消发布都会同步对应大纲节点状态（系统管理，用户不可手改）。
 */
const VIS_OPTIONS = [
  { id: 'public', label: '公开', icon: Globe, desc: '出现在发现页，任何人可读' },
  { id: 'unlisted', label: '链接可见', icon: Link2, desc: '不进发现页，持有链接可读' },
  { id: 'private', label: '私密', icon: Lock, desc: '仅自己可见' },
] as const;

const PublishModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  // 大纲顺序（备忘录 L57）：发布管理中章节严格按大纲排列顺序排序与发布
  const outlineActs = useOutlineStore((s) => (currentNovel ? s.byNovel[currentNovel.id] : undefined));
  const orderedChapters = useMemo(
    () => sortChaptersByOutline(chapters, outlineActs),
    [chapters, outlineActs],
  );

  // 发布状态（系统事实）：work + 已发布章节
  const publishState = usePublishStore((s) => (currentNovel ? s.byNovel[currentNovel.id] : undefined));
  const published = publishState?.work ?? null;
  const pubByChapterId = useMemo(
    () => new Map((publishState?.chapters ?? []).map((c) => [c.chapter_id, c])),
    [publishState?.chapters],
  );
  /** 未发布章节：可勾选发布的范围（已发布的需先取消发布） */
  const unpublishedChapters = useMemo(
    () => orderedChapters.filter((c) => !pubByChapterId.has(c.id)),
    [orderedChapters, pubByChapterId],
  );

  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // 作品级表单
  const [title, setTitle] = useState('');
  const [synopsis, setSynopsis] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>('public');
  const [coverUrl, setCoverUrl] = useState('');
  const [coverUploading, setCoverUploading] = useState(false);

  // 章节选择
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [useSchedule, setUseSchedule] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  const readUrl = published ? `${window.location.origin}/read/${published.slug}` : '';

  /** 把指定章节绑定的大纲节点状态同步为 status（发布→published，取消发布→done） */
  const syncOutlineStatus = useCallback(
    async (chapterIds: number[], status: OutlineStatus) => {
      const nid = currentNovel?.id;
      if (!nid || chapterIds.length === 0) return;
      const st = useOutlineStore.getState();
      if (!st.byNovel[nid]) await st.loadOutline(nid);
      const acts = useOutlineStore.getState().byNovel[nid] ?? [];
      const idset = new Set(chapterIds);
      for (const act of acts) {
        for (const node of act.nodes) {
          if (node.chapter_id != null && idset.has(node.chapter_id) && node.status !== status) {
            useOutlineStore.getState().updateNode(nid, act.id, node.id, { status });
          }
        }
      }
    },
    [currentNovel],
  );

  // 打开时加载发布状态（系统事实）与大纲（章节顺序依据）
  useEffect(() => {
    if (!open || !currentNovel) return;
    setTitle(currentNovel.title || '');
    setSynopsis(currentNovel.description || '');
    setVisibility('public');
    setSelected(new Set());
    setUseSchedule(false);
    setScheduledAt('');
    setLoading(true);
    void usePublishStore
      .getState()
      .load(currentNovel.id)
      .finally(() => setLoading(false));
    // 大纲未加载时补拉（章节按大纲序排序与发布的前提）
    if (!useOutlineStore.getState().byNovel[currentNovel.id]) {
      void useOutlineStore.getState().loadOutline(currentNovel.id);
    }
  }, [open, currentNovel]);

  const handlePublishWork = useCallback(async () => {
    if (!currentNovel || !title.trim()) return;
    setPublishing(true);
    try {
      const w = await publishWork({
        novel_id: currentNovel.id,
        title: title.trim(),
        synopsis: synopsis.trim(),
        visibility,
        cover_url: coverUrl || undefined,
      });
      await usePublishStore.getState().load(currentNovel.id);
      track('publish_work', { work_id: w.id, visibility });
      toast.show('作品已发布，现在可以选择章节', 'success');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  }, [currentNovel, title, synopsis, visibility]);

  const handlePublishChapters = useCallback(async () => {
    if (!published || !currentNovel || selected.size === 0) return;
    setPublishing(true);
    try {
      const scheduled = useSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : undefined;
      const done: Awaited<ReturnType<typeof publishChapter>>[] = [];
      // 备忘录 L57：按大纲顺序依次发布（勾选集合按 orderedChapters 展示序展开）
      for (const ch of orderedChapters) {
        if (!selected.has(ch.id)) continue;
        done.push(await publishChapter(published.id, { chapter_id: ch.id, scheduled_at: scheduled }));
        track('publish_chapter', { work_id: published.id, chapter_id: ch.id });
      }
      // 立即发布的章节同步大纲节点为「已发布」；定时发布的保持原状态，到点由读者侧生效
      const immediate = scheduled ? [] : done.map((d) => d.chapter_id);
      await usePublishStore.getState().markPublished(currentNovel.id, done);
      await syncOutlineStatus(immediate, 'published');
      toast.show(`已发布 ${done.length} 章${scheduled ? '（定时）' : ''}`, 'success');
      setSelected(new Set());
      setUseSchedule(false);
      setScheduledAt('');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '章节发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  }, [published, currentNovel, selected, orderedChapters, useSchedule, scheduledAt, syncOutlineStatus]);

  /** 取消发布单章：系统移除公开快照，大纲节点回「已完成」 */
  const handleUnpublishChapter = useCallback(
    async (chapterId: number, pid: number) => {
      if (!currentNovel) return;
      try {
        await unpublishChapter(pid);
        await usePublishStore.getState().markUnpublished(currentNovel.id, chapterId);
        await syncOutlineStatus([chapterId], 'done');
        toast.show('已取消发布该章', 'info');
      } catch (e) {
        toast.show(e instanceof Error ? e.message : '取消发布失败', 'error');
      }
    },
    [currentNovel, syncOutlineStatus],
  );

  const toggleChapter = (id: number) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!open) return null;

  // Portal 到 document.body：本弹窗挂载在 Toolbar 内，而 Toolbar 根节点带
  // backdrop-blur——backdrop-filter 会为 fixed 后代建立 containing block，
  // 使 inset-0 只覆盖工具栏那一小条、弹窗内容被编辑器其它表面遮挡（历史
  // 多发的“弹窗内容被盖住”根因）。挂到 body 后 fixed 恢复相对视口定位。
  // 与 common/Modal.tsx 的 Portal 策略保持一致，避免同类问题复发。
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto bg-surface-1 rounded-2xl border border-white/8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/6">
          <h2 className="text-sm font-semibold text-neutral-100">发布到 InkBloom</h2>
          <button type="button" onClick={onClose} className="p-1 rounded text-neutral-500 hover:text-neutral-200">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 size={20} className="animate-spin text-neutral-500" />
            </div>
          ) : !published ? (
            /* ── 阶段 1：发布作品 ── */
            <>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">作品标题</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/8 text-neutral-200 outline-none focus:border-brand-500/50"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">简介</label>
                <textarea
                  value={synopsis}
                  onChange={(e) => setSynopsis(e.target.value)}
                  rows={3}
                  placeholder="一句话吸引读者…"
                  className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/8 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-brand-500/50 resize-none"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">封面</label>
                <div className="flex items-center gap-2">
                  {coverUrl ? (
                    <img src={coverUrl} alt="封面" className="w-16 h-20 object-cover rounded-lg border border-white/10" />
                  ) : (
                    <div className="w-16 h-20 flex items-center justify-center rounded-lg bg-white/4 border border-dashed border-white/10 text-neutral-600">
                      <ImagePlus size={16} />
                    </div>
                  )}
                  <label className="cursor-pointer px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/8 text-xs text-neutral-300 hover:bg-white/10 transition-colors">
                    {coverUploading ? <Loader2 size={12} className="inline mr-1 animate-spin" /> : <ImagePlus size={12} className="inline mr-1" />}
                    {coverUploading ? '上传中…' : '上传封面'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f || !currentNovel) return;
                        setCoverUploading(true);
                        try {
                          const img = await uploadImage(f, { scope: 'novel', novelId: currentNovel.id });
                          setCoverUrl(img.url);
                        } catch (err) {
                          toast.show(err instanceof Error ? err.message : '封面上传失败', 'error');
                        } finally {
                          setCoverUploading(false);
                        }
                      }}
                    />
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-2">可见性</label>
                <div className="space-y-1.5">
                  {VIS_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setVisibility(opt.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                        visibility === opt.id
                          ? 'bg-brand-600/20 border border-brand-500/30'
                          : 'bg-white/4 border border-white/6 hover:bg-white/6'
                      }`}
                    >
                      <opt.icon size={14} className={visibility === opt.id ? 'text-brand-300' : 'text-neutral-400'} />
                      <span className="text-xs text-neutral-200">{opt.label}</span>
                      <span className="text-[10px] text-neutral-500">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handlePublishWork()}
                disabled={!title.trim() || publishing}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 transition-colors"
              >
                {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                发布作品
              </button>
            </>
          ) : (
            /* ── 阶段 2：选择章节发布 ── */
            <>
              {/* 已发布信息 + 阅读链接 */}
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/8 border border-emerald-500/20">
                <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-emerald-300">作品已发布</p>
                  <a
                    href={readUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-emerald-400/70 hover:text-emerald-300 flex items-center gap-1"
                  >
                    {readUrl.replace(window.location.origin, '')}
                    <ExternalLink size={10} />
                  </a>
                </div>
                <span className="text-[10px] text-neutral-500">关注 {published.follow_count}</span>
              </div>

              {/* 章节列表：已发布章节不可勾选（只能先取消发布再发布），可单独取消发布 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-neutral-400">选择要发布的章节</label>
                  <button
                    type="button"
                    onClick={() => {
                      if (selected.size === unpublishedChapters.length) setSelected(new Set());
                      else setSelected(new Set(unpublishedChapters.map((c) => c.id)));
                    }}
                    disabled={unpublishedChapters.length === 0}
                    className="text-[10px] text-brand-400 hover:text-brand-300 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {selected.size === unpublishedChapters.length && unpublishedChapters.length > 0
                      ? '取消全选'
                      : '全选未发布'}
                  </button>
                </div>
                <div className="space-y-1 max-h-[240px] overflow-y-auto">
                  {orderedChapters.map((ch, idx) => {
                    const checked = selected.has(ch.id);
                    const pub = pubByChapterId.get(ch.id);
                    const scheduledLater = pub?.scheduled_at && new Date(pub.scheduled_at) > new Date();
                    return (
                      <div
                        key={ch.id}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                          checked ? 'bg-brand-600/15' : pub ? 'opacity-60' : 'bg-white/4 hover:bg-white/6'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleChapter(ch.id)}
                          disabled={!!pub}
                          title={pub ? '已发布章节不可重复勾选；如需更新内容，先取消发布再发布' : undefined}
                          className="w-3.5 h-3.5 accent-brand-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                        {/* 大纲序号（备忘录 L57）：章节顺序严格按大纲排列顺序 */}
                        <span className="shrink-0 w-6 text-right text-[10px] text-neutral-600 tabular-nums">
                          {idx + 1}
                        </span>
                        <span className="text-xs text-neutral-200 flex-1 truncate">{ch.title}</span>
                        {pub && (
                          <span
                            className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border ${
                              scheduledLater
                                ? 'bg-amber-500/12 text-amber-300 border-amber-500/25'
                                : 'bg-sky-500/12 text-sky-300 border-sky-500/25'
                            }`}
                          >
                            {scheduledLater ? '定时已排' : '已发布'}
                          </span>
                        )}
                        <span className="text-[10px] text-neutral-500">{ch.word_count}字</span>
                        {pub && (
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `取消发布后读者将立即无法阅读「${ch.title}」，确定取消发布？`,
                                )
                              ) {
                                void handleUnpublishChapter(ch.id, pub.id);
                              }
                            }}
                            title="取消发布该章（读者将不可见）"
                            className="shrink-0 p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {orderedChapters.length === 0 && (
                    <p className="text-xs text-neutral-500 text-center py-4">还没有章节</p>
                  )}
                </div>
              </div>

              {/* 定时发布 */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSchedule}
                  onChange={(e) => setUseSchedule(e.target.checked)}
                  className="w-3.5 h-3.5 accent-brand-500 cursor-pointer"
                />
                <span className="text-xs text-neutral-400">定时发布</span>
                {useSchedule && (
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="ml-2 px-2 py-1 text-xs rounded bg-white/5 border border-white/8 text-neutral-200 outline-none"
                  />
                )}
              </label>

              <button
                type="button"
                onClick={() => void handlePublishChapters()}
                disabled={selected.size === 0 || publishing || (useSchedule && !scheduledAt)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 transition-colors"
              >
                {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                发布 {selected.size > 0 ? `${selected.size} 章` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default PublishModal;
