import React, { useCallback, useEffect, useState } from 'react';
import {
  History,
  Loader2,
  PenLine,
  Send,
  Clock3,
  Trash2,
  RotateCcw,
  Archive,
  Undo2,
  AlertTriangle,
  GitCompare,
  Check,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import DiffViewer from '@/components/editor/DiffViewer';
import { useTabStore, chapterTabKey, countDraftWords } from '@/stores/tab-store';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import { toast } from '@/components/common/Toast';
import {
  getVersionSummary,
  checkoutPublished,
  fetchChapterContent,
  type VersionPanelSummary,
} from '@/services/history-client';
import {
  getWorkspace,
  putAutoSnapshot,
  putManualSnapshot,
  replaceManualSnapshot,
  removeManualSnapshot,
  MANUAL_SLOTS,
  type WorkspaceStore,
  type WorkspaceSnapshot,
} from '@/utils/temp-branch';
import { htmlToPlainText } from '@/utils/html';
import VersionCompare from './VersionCompare';

/**
 * 版本管理（备忘录 L61 三态）：
 *
 *   发布   —— 服务器第二份文章（published_chapters 冻结副本 + 快照指针）。
 *             元数据常驻，正文只在点「对比 / 回滚」时按需拉取。
 *   工作区 —— 浏览器本地快照区（服务器永不保存第三份）：
 *             自动快照 ×1（回滚前 / AI 覆盖前 / 点击已完成时）+ 手动快照 ×2，
 *             手动超限时弹出替换选择（选中高亮 → 确定替换）。
 *   草稿正文由编辑器防抖与服务器交换（15s 降频 + 切章/关页立即落盘）。
 */

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

/** 快照 vs 当前正文 的本地对比窗口（零服务器流量） */
const SnapshotCompare: React.FC<{
  snapshot: WorkspaceSnapshot;
  current: string;
  onClose: () => void;
  onRestore: (snap: WorkspaceSnapshot) => void;
}> = ({ snapshot, current, onClose, onRestore }) => {
  return (
    <DiffViewer
      original={htmlToPlainText(snapshot.content)}
      modified={htmlToPlainText(current)}
      onAccept={() => onRestore(snapshot)}
      onReject={onClose}
      title={`快照对比 · ${snapshot.source}`}
      acceptText="恢复此快照"
      rejectText="关闭"
      leftLabel={`快照 · ${formatTime(snapshot.saved_at)}`}
      rightLabel="当前正文"
      overlayClass="z-[1400]"
    />
  );
};

const HistoryPanel: React.FC = () => {
  const open = useUIStore((s) => s.historyOpen);
  const setHistoryOpen = useUIStore((s) => s.setHistoryOpen);

  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  const activeChapterId = activeTab?.chapterId ?? null;

  const chapters = useNovelStore((s) => s.chapters);

  const [summary, setSummary] = useState<VersionPanelSummary | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceStore>(() => getWorkspace(0));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /** 快照对比（工作区快照 vs 当前正文，纯本地） */
  const [snapCompare, setSnapCompare] = useState<WorkspaceSnapshot | null>(null);
  /** 手动槽满时的替换选择：记录待写入内容，选中下标高亮，确定替换 */
  const [replacePick, setReplacePick] = useState<{ content: string; source: string } | null>(null);
  const [replaceIdx, setReplaceIdx] = useState(0);

  const refreshWorkspace = useCallback((chapterId: number) => {
    setWorkspace(getWorkspace(chapterId));
  }, []);

  const reload = useCallback(
    async (chapterId: number) => {
      setLoading(true);
      setError('');
      try {
        const s = await getVersionSummary(chapterId);
        setSummary(s);
        refreshWorkspace(chapterId);
      } catch (e) {
        setError(e instanceof Error ? e.message : '版本概要加载失败');
      } finally {
        setLoading(false);
      }
    },
    [refreshWorkspace],
  );

  useEffect(() => {
    if (open && activeChapterId !== null) {
      void reload(activeChapterId);
    }
    if (!open) {
      setSummary(null);
      setCompareOpen(false);
      setSnapCompare(null);
      setReplacePick(null);
      setError('');
    }
  }, [open, activeChapterId, reload]);

  /** 当前编辑器草稿（tab 脏草稿优先；否则取服务器正文） */
  const currentDraft = useCallback(async (): Promise<string> => {
    if (activeTab && activeTab.kind === 'chapter') {
      if (activeTab.isDirty && activeTab.draft) return activeTab.draft;
    }
    if (activeChapterId === null) return '';
    return fetchChapterContent(activeChapterId);
  }, [activeTab, activeChapterId]);

  /** 灌内容进编辑器 tab（不触发立即保存，由 15s 防抖 / 手动保存接管） */
  const applyToEditor = useCallback(
    (content: string, dirty: boolean) => {
      if (activeChapterId === null) return;
      useTabStore.getState().updateTab(chapterTabKey(activeChapterId), {
        draft: content,
        wordCount: countDraftWords(content),
        isDirty: dirty,
        saveStatus: dirty ? 'idle' : 'saved',
      });
    },
    [activeChapterId],
  );

  /** 手动暂存：满槽时进入替换选择流程 */
  const handleStash = useCallback(async () => {
    if (activeChapterId === null) return;
    const content = await currentDraft();
    if (!content.trim()) {
      toast.show('当前正文为空，无需暂存', 'info');
      return;
    }
    if (putManualSnapshot(activeChapterId, content) === 'full') {
      setReplacePick({ content, source: '手动暂存' });
      setReplaceIdx(0);
      return;
    }
    refreshWorkspace(activeChapterId);
    toast.show('已暂存到工作区（仅存本浏览器）', 'success');
  }, [activeChapterId, currentDraft, refreshWorkspace]);

  /** 确认替换选中的手动快照 */
  const confirmReplace = useCallback(() => {
    if (activeChapterId === null || !replacePick) return;
    replaceManualSnapshot(activeChapterId, replaceIdx, replacePick.content, replacePick.source);
    setReplacePick(null);
    refreshWorkspace(activeChapterId);
    toast.show(`已替换第 ${replaceIdx + 1} 条手动快照`, 'success');
  }, [activeChapterId, replacePick, replaceIdx, refreshWorkspace]);

  /** 恢复快照到编辑器：先把当前正文压入自动快照（保证可撤销），再灌快照内容 */
  const handleRestoreSnapshot = useCallback(
    (snap: WorkspaceSnapshot) => {
      if (activeChapterId === null) return;
      void (async () => {
        setWorking(true);
        try {
          const current = await currentDraft();
          if (current.trim() && current !== snap.content) {
            putAutoSnapshot(activeChapterId, current, '恢复快照前');
          }
          applyToEditor(snap.content, true);
          refreshWorkspace(activeChapterId);
          setSnapCompare(null);
          toast.show('快照已恢复到编辑器，保存后生效', 'success');
        } catch (e) {
          toast.show(e instanceof Error ? e.message : '恢复失败', 'error');
        } finally {
          setWorking(false);
        }
      })();
    },
    [activeChapterId, currentDraft, applyToEditor, refreshWorkspace],
  );

  /** 回滚到发布版（先自动快照当前草稿；checkout 响应体直灌编辑器） */
  const handleRollback = useCallback(async () => {
    if (activeChapterId === null) return;
    setWorking(true);
    try {
      const current = await currentDraft();
      if (current.trim()) {
        putAutoSnapshot(activeChapterId, current, '回滚到发布版前');
        toast.show('当前草稿已存入工作区自动快照，可随时恢复', 'info');
      }
      const content = await checkoutPublished(activeChapterId);
      applyToEditor(content, false);
      toast.show('已回滚到发布版本', 'success');
      await reload(activeChapterId);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '回滚失败', 'error');
    } finally {
      setWorking(false);
    }
  }, [activeChapterId, currentDraft, applyToEditor, reload]);

  const draftWordCount =
    activeTab && activeTab.kind === 'chapter' ? activeTab.wordCount : (summary?.draft.word_count ?? 0);
  const chapterTitle = chapters.find((c) => c.id === activeChapterId)?.title ?? '';

  /** 快照条目（自动/手动通用）：对比 + 恢复（+ 手动可删除） */
  const renderSnapshotRow = (snap: WorkspaceSnapshot, kind: 'auto' | 'manual', index?: number) => (
    <div key={snap.id} className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/3 border border-white/6">
      <Undo2 size={11} className="text-fuchsia-300/70 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-neutral-300 truncate">{snap.source}</span>
          <span className="text-[10px] text-neutral-500 tabular-nums shrink-0">
            {snap.word_count.toLocaleString()} 字
          </span>
        </div>
        <p className="text-[10px] text-neutral-600">{formatTime(snap.saved_at)}</p>
      </div>
      <button
        type="button"
        onClick={() => setSnapCompare(snap)}
        title="快照 vs 当前正文 对比（本地渲染，不访问服务器）"
        className="shrink-0 p-1 rounded text-neutral-500 hover:text-sky-300 hover:bg-sky-500/10 transition-colors"
      >
        <GitCompare size={11} />
      </button>
      <button
        type="button"
        onClick={() => handleRestoreSnapshot(snap)}
        disabled={working}
        title="恢复到编辑器（当前正文会先存入自动快照）"
        className="shrink-0 px-2 py-1 text-[10px] rounded text-fuchsia-200 hover:bg-fuchsia-500/15 disabled:opacity-40 transition-colors"
      >
        恢复
      </button>
      {kind === 'manual' && (
        <button
          type="button"
          onClick={() => {
            if (activeChapterId === null) return;
            removeManualSnapshot(activeChapterId, snap.id);
            refreshWorkspace(activeChapterId);
          }}
          title="删除该手动快照"
          className="shrink-0 p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={11} />
        </button>
      )}
      {kind === 'manual' && index !== undefined && (
        <span className="shrink-0 text-[9px] text-neutral-600 tabular-nums w-3 text-center">{index + 1}</span>
      )}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={() => setHistoryOpen(false)}
      title={
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-brand-300" />
          <span>版本管理</span>
          {chapterTitle && (
            <span className="text-xs text-neutral-500 font-normal truncate max-w-[180px]">
              {chapterTitle}
            </span>
          )}
        </div>
      }
      width="520px"
    >
      <div className="px-4 pb-4 space-y-3">
        {error && (
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {activeChapterId === null && (
          <div className="py-8 text-center text-xs text-neutral-500">
            请先打开一个章节再管理其版本
          </div>
        )}

        {loading && !summary && (
          <div className="py-8 flex justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
          </div>
        )}

        {summary && (
          <>
            {/* 发布（服务器第二份文章；正文按需拉取） */}
            {summary.published ? (
              <div className="rounded-xl border border-sky-500/25 bg-sky-500/6 px-3.5 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <Send size={12} className="text-sky-300 shrink-0" />
                  <span className="text-xs font-semibold text-neutral-100">发布</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/12 text-sky-300 border border-sky-500/25">
                    服务器 · 冻结副本
                  </span>
                  <div className="flex-1" />
                  <span className="text-[10px] text-neutral-500 tabular-nums">
                    {summary.published.word_count.toLocaleString()} 字
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pl-5 mt-1.5">
                  <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                    <Clock3 size={10} />
                    {formatTime(summary.published.updated_at)}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setCompareOpen(true)}
                    title="发布版 vs 当前正文（此时才拉取发布正文）"
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-white/6 text-neutral-200 hover:bg-white/12 border border-white/8 transition-colors"
                  >
                    对比
                  </button>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => void handleRollback()}
                    title="回滚前自动把当前草稿存入工作区自动快照（可撤销）"
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-amber-600/25 text-amber-200 hover:bg-amber-600/35 disabled:opacity-50 transition-colors"
                  >
                    {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw size={11} />}
                    回滚到此版
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <Send size={12} className="text-neutral-600 shrink-0" />
                  <span className="text-xs font-semibold text-neutral-500">发布</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/5 text-neutral-500 border border-white/8">
                    未发布
                  </span>
                </div>
                <p className="text-[11px] text-neutral-600 pl-5 mt-1">
                  在作品概览页「发布管理」中推送章节后，这里会出现不可变的发布副本。
                </p>
              </div>
            )}

            {/* 工作区（浏览器本地：自动 ×1 + 手动 ×2） */}
            <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 px-3.5 py-3">
              <div className="flex items-center gap-2 mb-1">
                <Archive size={13} className="text-fuchsia-300 shrink-0" />
                <span className="text-xs font-semibold text-neutral-100">工作区</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-fuchsia-500/12 text-fuchsia-300 border border-fuchsia-500/25">
                  仅存本浏览器 · 服务器不保存
                </span>
                <div className="flex-1" />
                <span className="flex items-center gap-1 text-[10px] text-neutral-500 tabular-nums mr-1">
                  <PenLine size={10} />
                  当前 {draftWordCount.toLocaleString()} 字
                </span>
                <button
                  type="button"
                  onClick={() => void handleStash()}
                  disabled={working}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-md bg-fuchsia-600/20 text-fuchsia-200 hover:bg-fuchsia-600/30 disabled:opacity-50 transition-colors"
                >
                  <Archive size={11} />
                  暂存当前
                </button>
              </div>
              <p className="text-[11px] text-neutral-500 pl-5 mb-2">
                自动快照 ×1（回滚前 / AI 覆盖前 / 点击已完成时）+ 手动快照 ×2；超出时选择一条替换。
              </p>

              {/* 自动快照槽 */}
              <div className="pl-5 space-y-1">
                {workspace.auto ? (
                  renderSnapshotRow(workspace.auto, 'auto')
                ) : (
                  <p className="text-[11px] text-neutral-600">自动快照：暂无（回滚 / AI 覆盖 / 点击已完成时自动生成）</p>
                )}
                {/* 手动快照槽 ×2 */}
                {Array.from({ length: MANUAL_SLOTS }).map((_, i) => {
                  const snap = workspace.manual[i];
                  return snap ? (
                    renderSnapshotRow(snap, 'manual', i)
                  ) : (
                    <div
                      key={`empty-${i}`}
                      className="px-2.5 py-1.5 rounded-lg border border-dashed border-white/8 text-[11px] text-neutral-600"
                    >
                      手动快照 {i + 1}：空槽
                    </div>
                  );
                })}
              </div>

              {/* 替换选择：手动槽满时，装载两条快照标签元素，选中高亮 → 确定替换 */}
              {replacePick && (
                <div className="mt-2 pl-5 pt-2 border-t border-white/8">
                  <p className="text-[11px] text-neutral-400 mb-1.5">
                    手动快照已满 —— 选择要替换的一条：
                  </p>
                  <div className="space-y-1 mb-2">
                    {workspace.manual.map((snap, i) => (
                      <button
                        key={snap.id}
                        type="button"
                        onClick={() => setReplaceIdx(i)}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                          replaceIdx === i
                            ? 'border-fuchsia-400/60 bg-fuchsia-500/15'
                            : 'border-white/8 bg-white/3 hover:bg-white/6'
                        }`}
                      >
                        {replaceIdx === i ? (
                          <Check size={11} className="text-fuchsia-300 shrink-0" />
                        ) : (
                          <Undo2 size={11} className="text-neutral-600 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-neutral-300 truncate">
                              手动快照 {i + 1} · {snap.source}
                            </span>
                            <span className="text-[10px] text-neutral-500 tabular-nums shrink-0">
                              {snap.word_count.toLocaleString()} 字
                            </span>
                          </div>
                          <p className="text-[10px] text-neutral-600">{formatTime(snap.saved_at)}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReplacePick(null)}
                      className="px-2.5 py-1 text-[11px] rounded-md text-neutral-400 hover:bg-white/8 transition-colors"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={confirmReplace}
                      className="px-3 py-1 text-[11px] rounded-md font-medium text-white bg-fuchsia-600 hover:bg-fuchsia-500 transition-colors"
                    >
                      确定替换
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 发布版 vs 当前正文 对比（此时才拉取发布正文；VSCode 左右分屏） */}
      {compareOpen && activeChapterId !== null && (
        <VersionCompare
          open
          chapterId={activeChapterId}
          onClose={() => setCompareOpen(false)}
          onRestored={async () => {
            if (activeChapterId !== null) await reload(activeChapterId);
          }}
        />
      )}

      {/* 工作区快照 vs 当前正文 对比（纯本地，accept=恢复该快照） */}
      {snapCompare && (
        <SnapshotCompareBridge
          chapterId={activeChapterId}
          snapshot={snapCompare}
          onClose={() => setSnapCompare(null)}
          onRestore={handleRestoreSnapshot}
        />
      )}
    </Modal>
  );
};

/** 桥接：拉取当前正文后再渲染本地对比（保持 SnapshotCompare 纯渲染） */
const SnapshotCompareBridge: React.FC<{
  chapterId: number | null;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onRestore: (snap: WorkspaceSnapshot) => void;
}> = ({ chapterId, snapshot, onClose, onRestore }) => {
  const [current, setCurrent] = useState<string>('');
  useEffect(() => {
    void (async () => {
      if (chapterId === null) return;
      const tab = useTabStore.getState().tabs.find((t) => t.key === chapterTabKey(chapterId));
      if (tab?.kind === 'chapter' && tab.isDirty && tab.draft) {
        setCurrent(tab.draft);
      } else {
        setCurrent(await fetchChapterContent(chapterId));
      }
    })();
  }, [chapterId]);
  if (chapterId === null) return null;
  return (
    <SnapshotCompare snapshot={snapshot} current={current} onClose={onClose} onRestore={onRestore} />
  );
};

export default HistoryPanel;


