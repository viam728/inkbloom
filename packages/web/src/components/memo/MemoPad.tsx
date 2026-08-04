import React, { useEffect, useState } from 'react';
import { Plus, Trash2, StickyNote, Search } from 'lucide-react';
import { useMemoStore } from '@/stores/memo-store';
import { useUIStore } from '@/stores/ui-store';
import RoleSwitcher from '@/components/layout/RoleSwitcher';
import TipTapEditor from '@/components/editor/TipTapEditor';

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** 从 HTML 提取首个非空文本行（作为随记标题预览） */
const firstLineOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .find((l) => l.trim()) ?? '';

/** 简约随记模式：极简双栏笔记，快速捕捉灵感，无作品结构负担 */
const MemoPad: React.FC = () => {
  const { notes, currentId, createNote, deleteNote, selectNote, updateNote, reorderNotes } =
    useMemoStore();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const current = notes.find((n) => n.id === currentId) ?? null;
  const [draft, setDraft] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    setDraft(current?.content ?? '');
    setWordCount(0);
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 首屏无笔记时自动创建
  useEffect(() => {
    if (notes.length === 0) createNote();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContentChange = (html: string) => {
    setDraft(html);
    if (current) {
      // 首行作为标题预览
      const firstLine = firstLineOf(html).slice(0, 30).trim();
      updateNote(current.id, {
        content: html,
        ...(firstLine ? { title: firstLine } : {}),
      });
    }
  };

  const handleDrop = (targetId: string) => {
    if (draggingId == null || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const next = notes.filter((n) => n.id !== draggingId);
    const at = next.findIndex((n) => n.id === targetId);
    const dragged = notes.find((n) => n.id === draggingId);
    if (dragged) next.splice(at, 0, dragged);
    reorderNotes(next.map((n) => n.id));
    setDraggingId(null);
    setDragOverId(null);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface-0 animate-fade-in">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/6 bg-surface-1/60">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center text-xs">
          🌸
        </div>
        <span className="text-sm font-semibold bg-gradient-to-r from-indigo-300 to-pink-300 bg-clip-text text-transparent">
          InkBloom 随记
        </span>
        <button
          onClick={() => setPaletteOpen(true)}
          className="ml-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-neutral-500 hover:text-neutral-300 hover:bg-white/6 transition-colors"
        >
          <Search size={12} />
          <kbd className="text-[10px]">Ctrl K</kbd>
        </button>
        <div className="flex-1" />
        <RoleSwitcher align="right" />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 笔记列表 */}
        <div className="w-56 shrink-0 border-r border-white/6 bg-surface-1 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              随记 · {notes.length}
            </span>
            <button
              onClick={() => createNote()}
              title="新建随记"
              className="p-1 rounded-md text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
            {notes.map((n) => {
              const isDragging = draggingId === n.id;
              const isDragOver = dragOverId === n.id && draggingId !== n.id;
              return (
                <div
                  key={n.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingId(n.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverId !== n.id) setDragOverId(n.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverId === n.id) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(n.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverId(null);
                  }}
                  onClick={() => selectNote(n.id)}
                  className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    n.id === currentId
                      ? 'bg-brand-600/15 text-neutral-100'
                      : 'text-neutral-400 hover:bg-white/5'
                  } ${isDragging ? 'opacity-40' : ''} ${
                    isDragOver ? 'ring-1 ring-brand-500/60 bg-brand-500/10' : ''
                  }`}
                >
                  <div className="text-xs font-medium truncate">{n.title}</div>
                  <div className="text-[10px] text-neutral-500 mt-0.5">{fmtTime(n.updated_at)}</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNote(n.id);
                    }}
                    className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 p-0.5 rounded text-neutral-500 hover:text-red-400 transition-all"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* 编辑区（复用富文本编辑器） */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-hidden flex justify-center bg-surface-0">
            <div className="w-full max-w-2xl h-full flex flex-col">
              {current ? (
                <TipTapEditor
                  key={current.id}
                  content={draft}
                  onChange={handleContentChange}
                  onWordCount={setWordCount}
                  variant="memo"
                  placeholder="随手记点什么…首行会自动成为标题。灵感、片段、待办，都可以先丢进来。"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-neutral-600">
                  创建一条随记开始记录
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between px-6 py-1.5 border-t border-white/6 text-[11px] text-neutral-600">
            <span className="flex items-center gap-1.5">
              <StickyNote size={11} />
              本地保存 · 随时可转入正式作品
            </span>
            <span className="tabular-nums">{wordCount} 字</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoPad;
