import React, { useState } from 'react';
import {
  Plus,
  Trash2,
  ListTree,
  Pencil,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import type { Chapter } from '@/types';
import Modal from '@/components/common/Modal';
import { useToast } from '@/components/common/Toast';

const ChapterList: React.FC = () => {
  const {
    currentNovel,
    chapters,
    currentChapter,
    createChapter,
    selectChapter,
    deleteChapter,
    renameChapter,
  } = useNovelStore();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [sortDesc, setSortDesc] = useState(false);

  // ── 重命名 ───────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState<Chapter | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  /** 展示顺序：默认按 sort_order 升序，可切换倒序 */
  const displayList = sortDesc ? [...chapters].reverse() : chapters;

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || !currentNovel || creating) return;
    setCreating(true);
    try {
      const chapter = await createChapter({
        novel_id: currentNovel.id,
        title,
      });
      setNewTitle('');
      setShowCreate(false);
      showToast(`章节「${title}」创建成功`, 'success');
      // 自动选中新建的章节
      if (chapter?.id) {
        await selectChapter(chapter);
      }
    } catch {
      showToast('创建失败，请重试', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteChapter(id);
      showToast('章节已删除', 'info');
    } catch {
      showToast('删除失败，请重试', 'error');
    }
    setDeleteConfirm(null);
  };

  const handleRename = async () => {
    const title = renameDraft.trim();
    if (!renameTarget || !title || renaming) return;
    setRenaming(true);
    try {
      await renameChapter(renameTarget.id, title);
      showToast('章节已重命名', 'success');
      setRenameTarget(null);
    } catch {
      showToast('重命名失败，请重试', 'error');
    } finally {
      setRenaming(false);
    }
  };

  if (!currentNovel) return null;

  return (
    <div className="flex flex-col mt-1.5 border-t border-white/6 pt-1.5">
      <div className="flex items-center justify-between px-3.5 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          章节 · {chapters.length}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSortDesc((v) => !v)}
            title={sortDesc ? '当前倒序，点击切换为正序' : '当前正序，点击切换为倒序'}
            className="p-1 rounded-md text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
          >
            {sortDesc ? <ArrowDownWideNarrow size={13} /> : <ArrowUpNarrowWide size={13} />}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            title="新建章节"
            className="p-1 rounded-md text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {chapters.length === 0 && (
        <button
          onClick={() => setShowCreate(true)}
          className="mx-3 my-1 px-3 py-4 rounded-lg border border-dashed border-white/10 text-neutral-500 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/5 transition-colors flex flex-col items-center gap-1.5"
        >
          <ListTree size={16} />
          <span className="text-xs">写下第一章</span>
        </button>
      )}

      {displayList.map((chapter: Chapter, idx: number) => {
        const active = currentChapter?.id === chapter.id;
        return (
          <div
            key={chapter.id}
            onClick={() => selectChapter(chapter)}
            className={`group relative flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
              active
                ? 'bg-gradient-to-r from-brand-600/20 to-brand-600/5 text-neutral-100'
                : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            }`}
          >
            {active && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-gradient-to-b from-indigo-400 to-pink-400" />
            )}
            <span
              className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[10px] font-semibold ${
                active ? 'bg-brand-500/20 text-brand-300' : 'bg-white/5 text-neutral-500'
              }`}
            >
              {sortDesc ? chapters.length - idx : idx + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] truncate">{chapter.title}</div>
              <div className="text-[11px] text-neutral-500 mt-0.5">
                {chapter.word_count ? `${chapter.word_count.toLocaleString()} 字` : '空'}
              </div>
            </div>
            {deleteConfirm === chapter.id ? (
              <div className="flex gap-1 shrink-0 animate-fade-in">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(chapter.id);
                  }}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                >
                  确认
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(null);
                  }}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-neutral-300 hover:bg-white/15 transition-colors"
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameTarget(chapter);
                    setRenameDraft(chapter.title);
                  }}
                  title="重命名章节"
                  className="p-1 rounded text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(chapter.id);
                  }}
                  title="删除章节"
                  className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* 新建对话框 */}
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setNewTitle('');
        }}
        title="新建章节"
      >
        <div className="px-5 py-4">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="输入章节标题…"
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => {
                setShowCreate(false);
                setNewTitle('');
              }}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim() || creating}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              {creating ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 重命名对话框 */}
      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="重命名章节"
      >
        <div className="px-5 py-4">
          <input
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            placeholder="输入新的章节标题…"
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setRenameTarget(null)}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleRename}
              disabled={!renameDraft.trim() || renaming}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              {renaming ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ChapterList;
