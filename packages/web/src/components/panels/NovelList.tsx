import React, { useState } from 'react';
import { BookOpen, Plus, Trash2, PenLine } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import type { Novel } from '@/types';
import Modal from '@/components/common/Modal';
import { useToast } from '@/components/common/Toast';

const NovelList: React.FC = () => {
  const { novels, currentNovel, loading, fetchNovels, createNovel, deleteNovel, selectNovel } =
    useNovelStore();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  React.useEffect(() => {
    fetchNovels();
  }, [fetchNovels]);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const novel = await createNovel({ title });
      setNewTitle('');
      setShowCreate(false);
      showToast(`作品「${title}」创建成功`, 'success');
      if (novel?.id) await selectNovel(novel);
    } catch {
      showToast('创建失败，请重试', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteNovel(id);
      showToast('作品已删除', 'info');
    } catch {
      showToast('删除失败，请重试', 'error');
    }
    setDeleteConfirm(null);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3.5 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          作品
        </span>
        <button
          onClick={() => setShowCreate(true)}
          title="新建作品"
          className="p-1 rounded-md text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* 加载骨架屏 */}
      {loading && (
        <div className="space-y-2 px-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-3 py-2.5 rounded-lg bg-white/3">
              <div className="skeleton h-3.5 w-3/4 mb-2" />
              <div className="skeleton h-2.5 w-1/3" />
            </div>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!loading && novels.length === 0 && (
        <button
          onClick={() => setShowCreate(true)}
          className="mx-3 my-1 px-3 py-4 rounded-lg border border-dashed border-white/10 text-neutral-500 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/5 transition-colors flex flex-col items-center gap-1.5"
        >
          <PenLine size={16} />
          <span className="text-xs">创建你的第一部作品</span>
        </button>
      )}

      {/* 列表 */}
      {novels.map((novel: Novel) => {
        const active = currentNovel?.id === novel.id;
        return (
          <div
            key={novel.id}
            onClick={() => selectNovel(novel)}
            className={`group relative flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
              active
                ? 'bg-gradient-to-r from-brand-600/20 to-brand-600/5 text-neutral-100'
                : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            }`}
          >
            {/* 激活指示条 */}
            {active && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-gradient-to-b from-indigo-400 to-pink-400" />
            )}
            <span
              className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${
                active ? 'bg-brand-500/20 text-brand-300' : 'bg-white/5 text-neutral-500'
              }`}
            >
              <BookOpen size={14} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate">{novel.title}</div>
              <div className="text-[11px] text-neutral-500 mt-0.5">
                {novel.word_count ? `${novel.word_count.toLocaleString()} 字` : '尚未开始'}
              </div>
            </div>
            {/* 删除按钮 */}
            {deleteConfirm === novel.id ? (
              <div className="flex gap-1 shrink-0 animate-fade-in">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(novel.id);
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm(novel.id);
                }}
                title="删除作品"
                className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
              >
                <Trash2 size={13} />
              </button>
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
        title="新建作品"
      >
        <div className="px-5 py-4">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="输入作品标题…"
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
    </div>
  );
};

export default NovelList;
