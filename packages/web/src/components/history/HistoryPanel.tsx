import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History,
  Loader2,
  RotateCcw,
  Save,
  GitCommitHorizontal,
  Sparkles,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useHistoryStore } from '@/stores/history-store';
import { useTabStore, chapterTabKey, countDraftWords } from '@/stores/tab-store';
import { useUIStore } from '@/stores/ui-store';
import { fetchChapterContent, type ChapterVersionKind } from '@/services/history-client';
import { toast } from '@/components/common/Toast';
import VersionCompare from './VersionCompare';

/**
 * 章节版本历史（业务方案 v3 E1，施工任务 A06）
 *
 * 入口：编辑器工具栏「历史」按钮 → ui-store.historyOpen。
 * 章节来源：当前激活的编辑 tab；无激活 tab 时面板不可用（不渲染按钮）。
 */

interface KindMeta {
  label: string;
  dot: string;
  text: string;
  icon: React.ReactNode;
}

const KIND_META: Record<ChapterVersionKind, KindMeta> = {
  auto: {
    label: '自动',
    dot: 'bg-neutral-500',
    text: 'text-neutral-400',
    icon: <GitCommitHorizontal className="w-3.5 h-3.5" />,
  },
  milestone: {
    label: '手动存档',
    dot: 'bg-brand-500',
    text: 'text-brand-300',
    icon: <Save className="w-3.5 h-3.5" />,
  },
  ai_rewrite: {
    label: 'AI 改写前',
    dot: 'bg-purple-500',
    text: 'text-purple-300',
    icon: <Sparkles className="w-3.5 h-3.5" />,
  },
  rollback: {
    label: '回滚前',
    dot: 'bg-amber-500',
    text: 'text-amber-300',
    icon: <RotateCcw className="w-3.5 h-3.5" />,
  },
  import: {
    label: '同步冲突',
    dot: 'bg-emerald-500',
    text: 'text-emerald-300',
    icon: <Upload className="w-3.5 h-3.5" />,
  },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

const HistoryPanel: React.FC = () => {
  const open = useUIStore((s) => s.historyOpen);
  const setHistoryOpen = useUIStore((s) => s.setHistoryOpen);

  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const activeChapterId = useMemo(
    () => tabs.find((t) => t.key === activeKey)?.chapterId ?? null,
    [tabs, activeKey],
  );

  const {
    versions,
    total,
    retention,
    loading,
    restoring,
    snapshotting,
    error,
    load,
    restore,
    snapshot,
    reset,
  } = useHistoryStore();

  /** 保留策略提示（A07）：手动存档永远保留，只有自动快照受期限约束 */
  const retentionHint = useMemo(() => {
    if (!retention) return null;
    if (retention.max_days === 0) return '自动快照永久保留';
    return `自动快照保留 ${retention.max_days} 天，手动存档永久保留`;
  }, [retention]);

  const [compareId, setCompareId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (open && activeChapterId !== null) {
      void load(activeChapterId);
    }
    if (!open) {
      setCompareId(null);
      setConfirmId(null);
      reset();
    }
  }, [open, activeChapterId, load, reset]);

  /** 回滚后把新正文灌回 tab 草稿，编辑器即时显示回滚结果 */
  const refreshTabContent = useCallback(async (chapterId: number) => {
    try {
      const content = await fetchChapterContent(chapterId);
      useTabStore.getState().updateTab(chapterTabKey(chapterId), {
        draft: content,
        wordCount: countDraftWords(content),
        isDirty: false,
        saveStatus: 'saved',
      });
    } catch {
      // 刷新失败不回滚已成功的恢复动作：用户可手动切换章节重取
      toast.show('已回滚，但编辑器刷新失败，请重新打开章节', 'error');
    }
  }, []);

  const handleRestore = useCallback(
    async (chapterId: number, versionId: number) => {
      const ok = await restore(chapterId, versionId);
      setConfirmId(null);
      if (!ok) return;
      await refreshTabContent(chapterId);
      toast.show('已回滚到该版本', 'success');
    },
    [restore, refreshTabContent],
  );

  const handleSnapshot = useCallback(async () => {
    if (activeChapterId === null) return;
    const id = await snapshot(activeChapterId, label.trim() || undefined);
    if (id !== null) {
      setLabel('');
      toast.show('已存档', 'success');
    }
  }, [activeChapterId, snapshot, label]);

  const confirmTarget = versions.find((v) => v.id === confirmId) ?? null;

  return (
    <Modal
      open={open}
      onClose={() => setHistoryOpen(false)}
      title={
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-brand-300" />
          <span>版本历史</span>
          {total > 0 && (
            <span className="text-xs text-neutral-500 font-normal">共 {total} 个版本</span>
          )}
        </div>
      }
      width="560px"
    >
      <div className="px-4 pb-4">
        {/* 手动存档 */}
        <div className="flex items-center gap-2 mb-3">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="存档名称（可选，如「定稿前」）"
            className="flex-1 px-2.5 py-1.5 text-xs rounded-md bg-white/5 border border-white/8 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
          />
          <button
            type="button"
            onClick={() => void handleSnapshot()}
            disabled={snapshotting || activeChapterId === null}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            {snapshotting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            存档
          </button>
        </div>

        {retentionHint && (
          <div className="mb-3 px-2.5 py-1.5 rounded-md bg-white/3 border border-white/6 text-[11px] text-neutral-500">
            {retentionHint}
          </div>
        )}

        {error && (
          <div className="mb-3 flex items-center gap-2 px-2.5 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {activeChapterId === null && (
          <div className="py-8 text-center text-xs text-neutral-500">
            请先打开一个章节再查看其版本历史
          </div>
        )}

        {loading && versions.length === 0 && (
          <div className="py-8 flex justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
          </div>
        )}

        {!loading && versions.length === 0 && activeChapterId !== null && (
          <div className="py-8 text-center text-xs text-neutral-500">
            还没有任何版本。继续写作，系统会自动保存历史快照。
          </div>
        )}

        {/* 版本时间线 */}
        <div className="space-y-1 max-h-[46vh] overflow-y-auto pr-1">
          {versions.map((v) => {
            const meta = KIND_META[v.kind] ?? KIND_META.auto;
            return (
              <div
                key={v.id}
                className="group flex items-start gap-2.5 px-2.5 py-2 rounded-lg hover:bg-white/4 transition-colors"
              >
                <div className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${meta.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${meta.text}`}>{meta.label}</span>
                    {v.label && (
                      <span className="text-xs text-neutral-300 truncate">{v.label}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {formatTime(v.created_at)} · {v.word_count} 字
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setCompareId(v.id)}
                    title="与当前正文对比"
                    className="px-2 py-1 text-[11px] rounded text-neutral-400 hover:bg-white/8 hover:text-neutral-200 transition-colors"
                  >
                    对比
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(v.id)}
                    disabled={restoring}
                    title="回滚到此版本"
                    className="px-2 py-1 text-[11px] rounded text-neutral-400 hover:bg-amber-500/15 hover:text-amber-300 disabled:opacity-40 transition-colors"
                  >
                    回滚
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 回滚二次确认 */}
      {confirmTarget && activeChapterId !== null && (
        <div className="border-t border-white/8 px-4 py-3 bg-amber-500/5">
          <div className="flex items-start gap-2 text-xs text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">
              确认回滚到
              <span className="font-medium mx-1">
                {formatTime(confirmTarget.created_at)}
              </span>
              的版本？当前正文会先被存为一个新版本，可再次回滚撤销。
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-2.5">
            <button
              type="button"
              onClick={() => setConfirmId(null)}
              className="px-2.5 py-1 text-xs rounded text-neutral-400 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              disabled={restoring}
              onClick={() => void handleRestore(activeChapterId, confirmTarget.id)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-amber-600/25 text-amber-200 hover:bg-amber-600/35 disabled:opacity-50 transition-colors"
            >
              {restoring && <Loader2 className="w-3 h-3 animate-spin" />}
              确认回滚
            </button>
          </div>
        </div>
      )}

      {/* 差异对比层 */}
      {compareId !== null && activeChapterId !== null && (
        <VersionCompare
          open
          chapterId={activeChapterId}
          versionId={compareId}
          onClose={() => setCompareId(null)}
          onRestored={async () => {
            setCompareId(null);
            await refreshTabContent(activeChapterId);
          }}
        />
      )}
    </Modal>
  );
};

export default HistoryPanel;
