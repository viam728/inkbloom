import React, { useCallback, useEffect, useState } from 'react';
import { X, Loader2, MessageSquare, ThumbsUp, Check, Flag } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { useReaderInteractionStore } from '@/stores/reader-interaction-store';
import {
  listInteractions,
  createInteraction,
  likeInteraction,
  adoptInteraction,
  hideInteraction,
} from '@/services/reader-client';
import type { Interaction, InteractionList } from '@/types/published';
import { track } from '@/services/analytics';
import { toast } from '@/components/common/Toast';

const MOODS: Record<string, { label: string; emoji: string }> = {
  fire: { label: '燃', emoji: '🔥' },
  knife: { label: '刀', emoji: '💔' },
  sweet: { label: '甜', emoji: '🍬' },
  mystery: { label: '谜', emoji: '❓' },
};

/**
 * 读者互动面板（业务方案 v3 E5 交互式微创作，施工任务 A29）。
 *
 * 由 reader-interaction-store 驱动：ChapterReader 的段落悬停情绪点击、
 * 选中划线评论都汇聚到这里（评论经 composer 上下文锚定到具体段落）。
 */
const ReaderInteractions: React.FC<{ chapterId: number }> = ({ chapterId }) => {
  const { open, composer, version, setOpen } = useReaderInteractionStore();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const isAuthed = status === 'authed';

  const [list, setList] = useState<InteractionList | null>(null);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listInteractions(chapterId);
      setList(data);
    } catch {
      /* 互动列表加载失败不打断阅读 */
    } finally {
      setLoading(false);
    }
  }, [chapterId]);

  // 打开或数据版本变化时刷新；评论上下文变化时清空输入
  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, version, refresh]);

  useEffect(() => {
    if (composer) {
      setText(composer.anchor ? `「${composer.anchor}」 ` : '');
    } else {
      setText('');
    }
  }, [composer]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || !isAuthed) return;
    setPosting(true);
    try {
      await createInteraction(chapterId, {
        type: 'comment',
        block_index: composer?.block_index ?? 0,
        anchor: composer?.anchor,
        payload: { text: trimmed },
      });
      setText('');
      track('interaction_created', { type: 'comment', chapter_id: chapterId });
      useReaderInteractionStore.getState().bump();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '评论失败', 'error');
    } finally {
      setPosting(false);
    }
  };

  const toggleLike = async (it: Interaction) => {
    if (!isAuthed) {
      toast.show('登录后即可点赞', 'info');
      return;
    }
    try {
      const res = await likeInteraction(it.id);
      setList((prev) =>
        prev
          ? {
              ...prev,
              interactions: prev.interactions.map((x) =>
                x.id === it.id
                  ? { ...x, liked_by_me: res.liked, like_count: res.like_count }
                  : x,
              ),
            }
          : prev,
      );
    } catch {
      /* 忽略点赞失败 */
    }
  };

  const adopt = async (it: Interaction) => {
    try {
      await adoptInteraction(it.id);
      setList((prev) =>
        prev
          ? {
              ...prev,
              interactions: prev.interactions.map((x) =>
                x.id === it.id ? { ...x, status: 'adopted' } : x,
              ),
            }
          : prev,
      );
      toast.show('已采纳该读者建议', 'success');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '操作失败', 'error');
    }
  };

  const hide = async (it: Interaction) => {
    try {
      await hideInteraction(it.id);
      setList((prev) =>
        prev
          ? { ...prev, interactions: prev.interactions.filter((x) => x.id !== it.id) }
          : prev,
      );
    } catch {
      /* 忽略 */
    }
  };

  const comments = (list?.interactions ?? []).filter((i) => i.type === 'comment');
  const moods = (list?.interactions ?? []).filter((i) => i.type === 'mood');
  const moodSummary = moods.reduce<Record<string, number>>((acc, m) => {
    const key = m.payload?.mood ?? '';
    if (key) acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      {/* 悬浮开关：显示评论数 */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-1.5 rounded-full bg-brand-600 hover:bg-brand-500 text-white px-3.5 py-2.5 text-sm shadow-lg shadow-black/30 transition-colors"
        title="互动"
      >
        <MessageSquare size={15} />
        {comments.length > 0 && <span className="text-xs font-medium">{comments.length}</span>}
      </button>

      {/* 互动侧栏 */}
      {open && (
        <div className="fixed inset-y-0 right-0 z-50 w-[340px] max-w-[90vw] bg-surface-1 border-l border-white/8 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-4 h-12 border-b border-white/6 shrink-0">
            <h2 className="text-sm font-semibold text-neutral-200">读者互动</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1.5 rounded text-neutral-400 hover:text-neutral-200"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* 情绪汇总 */}
            {Object.keys(moodSummary).length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {Object.entries(moodSummary).map(([k, n]) => (
                  <span
                    key={k}
                    className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/5 border border-white/8 text-xs text-neutral-300"
                  >
                    <span>{MOODS[k]?.emoji ?? k}</span>
                    <span>{MOODS[k]?.label ?? k}</span>
                    <span className="text-neutral-500">×{n}</span>
                  </span>
                ))}
              </div>
            )}

            {/* 评论列表 */}
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 size={18} className="animate-spin text-neutral-500" />
              </div>
            ) : comments.length === 0 ? (
              <p className="text-xs text-neutral-500 text-center py-8">
                还没有评论，来当第一个划线的读者
              </p>
            ) : (
              <div className="space-y-3">
                {comments.map((it) => (
                  <div
                    key={it.id}
                    className="rounded-lg bg-white/4 border border-white/6 p-3 space-y-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-brand-300">
                        {it.nickname || `读者${it.user_id}`}
                      </span>
                      {it.is_author && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-brand-600/30 text-brand-300">
                          作者
                        </span>
                      )}
                      {it.status === 'adopted' && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                          已采纳
                        </span>
                      )}
                    </div>
                    {it.anchor && (
                      <p className="text-[11px] text-neutral-500 italic">「{it.anchor}」</p>
                    )}
                    <p className="text-xs text-neutral-200 leading-relaxed">{it.payload?.text}</p>
                    <div className="flex items-center gap-3 pt-0.5">
                      <button
                        type="button"
                        onClick={() => toggleLike(it)}
                        className={`flex items-center gap-1 text-[11px] ${
                          it.liked_by_me ? 'text-brand-300' : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                      >
                        <ThumbsUp size={12} />
                        {it.like_count > 0 ? it.like_count : '赞'}
                      </button>
                      {list?.is_author && it.status !== 'adopted' && (
                        <button
                          type="button"
                          onClick={() => adopt(it)}
                          className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300"
                        >
                          <Check size={12} /> 采纳
                        </button>
                      )}
                      {(list?.is_author || (user && Number(user.id) === it.user_id)) && (
                        <button
                          type="button"
                          onClick={() => hide(it)}
                          className="flex items-center gap-1 text-[11px] text-neutral-600 hover:text-neutral-400"
                          title="隐藏"
                        >
                          <Flag size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 评论输入区 */}
          <div className="p-3 border-t border-white/6 shrink-0">
            {!isAuthed ? (
              <p className="text-[11px] text-neutral-500 text-center py-1">
                登录后即可参与划线评论与情绪互动
              </p>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={2}
                  placeholder={composer?.anchor ? '评论这一段…' : '对本章说点什么…'}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-white/5 border border-white/8 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-brand-500/50 resize-none"
                />
                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!text.trim() || posting}
                    className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-500 disabled:opacity-50 transition-colors"
                  >
                    {posting ? <Loader2 size={12} className="animate-spin" /> : '发表'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default ReaderInteractions;
