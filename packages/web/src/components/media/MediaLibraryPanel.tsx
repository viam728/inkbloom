import React, { useEffect, useState } from 'react';
import { Plus, FileText, Megaphone, Trash2, GripVertical } from 'lucide-react';
import { useMediaStore } from '@/stores/media-store';
import { PLATFORMS, type MediaPlatform } from '@/types/media';
import Modal from '@/components/common/Modal';

const platformLabel = (id: MediaPlatform) => PLATFORMS.find((p) => p.id === id)?.label ?? id;

const MediaLibraryPanel: React.FC = () => {
  const {
    contents,
    currentContent,
    loadContents,
    createContent,
    selectContent,
    removeContent,
    reorderContents,
  } = useMediaStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPlatform, setNewPlatform] = useState<MediaPlatform>('wechat');
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  useEffect(() => {
    loadContents();
  }, [loadContents]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    await createContent({ title: newTitle.trim(), platform: newPlatform });
    setShowCreate(false);
    setNewTitle('');
  };

  const handleDrop = (targetId: number) => {
    if (draggingId == null || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const next = contents.filter((c) => c.id !== draggingId);
    const at = next.findIndex((c) => c.id === targetId);
    const dragged = contents.find((c) => c.id === draggingId);
    if (dragged) next.splice(at, 0, dragged);
    reorderContents(next.map((c) => c.id));
    setDraggingId(null);
    setDragOverId(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/6">
        <span className="text-xs font-medium text-neutral-300">内容库</span>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-brand-300 bg-brand-600/15 hover:bg-brand-600/25 transition-colors"
        >
          <Plus size={12} />
          新建
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {contents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Megaphone size={22} className="text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-500">
              还没有内容
              <br />
              点击「新建」开始创作
            </p>
          </div>
        )}
        {contents.map((item) => {
          const isDragging = draggingId === item.id;
          const isDragOver = dragOverId === item.id && draggingId !== item.id;
          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDraggingId(item.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragOverId !== item.id) setDragOverId(item.id);
              }}
              onDragLeave={() => {
                if (dragOverId === item.id) setDragOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(item.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDragOverId(null);
              }}
              onClick={() => selectContent(item)}
              className={`group relative mx-2 my-0.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                currentContent?.id === item.id
                  ? 'bg-brand-600/15 border border-brand-500/25'
                  : 'border border-transparent hover:bg-white/4'
              } ${isDragging ? 'opacity-40' : ''} ${
                isDragOver ? 'ring-1 ring-brand-500/60 bg-brand-500/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="shrink-0 text-neutral-600 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                  title="拖动调整顺序"
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripVertical size={11} />
                </span>
                <FileText size={13} className="text-neutral-500 shrink-0" />
                <span className="flex-1 text-xs text-neutral-200 truncate">{item.title}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/6 text-neutral-500">
                  {platformLabel(item.platform)}
                </span>
              </div>
            {/* 删除按钮 */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
              {deleteConfirm === item.id ? (
                <div className="flex gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeContent(item.id);
                      setDeleteConfirm(null);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white"
                  >
                    确认
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm(null);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-neutral-300 hover:bg-white/15"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(item.id);
                  }}
                  className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>

      {/* 新建对话框 */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="新建内容">
        <div className="px-5 py-4">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="内容标题…"
            className="w-full mb-3 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-500 outline-none focus:border-brand-500/50"
          />
          <p className="text-[11px] text-neutral-500 mb-2">选择目标平台</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                onClick={() => setNewPlatform(p.id)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                  newPlatform === p.id
                    ? 'bg-brand-600/25 text-brand-300 border border-brand-500/40'
                    : 'bg-white/5 text-neutral-400 border border-white/8 hover:bg-white/10'
                }`}
              >
                {p.emoji} {p.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleCreate}
            disabled={!newTitle.trim()}
            className="w-full py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm font-medium disabled:opacity-40 transition-all"
          >
            创建
          </button>
        </div>
      </Modal>
    </div>
  );
};

export default MediaLibraryPanel;
