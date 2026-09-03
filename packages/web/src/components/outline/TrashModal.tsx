import React, { useState } from 'react';
import { Check, RotateCcw, Trash2, X } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useToast } from '@/components/common/Toast';
import { useTrashStore } from '@/stores/trash-store';
import type { OutlineAct } from '@/stores/outline-store';

interface TrashModalProps {
  open: boolean;
  novelId: number;
  /** 现有幕列表：恢复时重选幕间归属 */
  acts: OutlineAct[];
  onClose: () => void;
  /** 恢复成功后刷新大纲与章节列表 */
  onRestored: () => Promise<void>;
}

/**
 * 回收站：列出已删除的要点（含正文），恢复时重选目标幕插回大纲；
 * 彻底删除为物理删除，不可恢复。
 */
const TrashModal: React.FC<TrashModalProps> = ({ open, novelId, acts, onClose, onRestored }) => {
  const items = useTrashStore((s) => s.byNovel[novelId] ?? []);
  const loading = useTrashStore((s) => s.loading);
  const restoringId = useTrashStore((s) => s.restoringId);
  const restore = useTrashStore((s) => s.restore);
  const purge = useTrashStore((s) => s.purge);
  const { showToast } = useToast();

  /** 正在选择目标幕的记录 id */
  const [pickingId, setPickingId] = useState<number | null>(null);
  const [targetActId, setTargetActId] = useState('');

  const handleRestore = async (trashId: number) => {
    try {
      await restore(novelId, trashId, targetActId);
      showToast(
        targetActId ? '已恢复到所选幕' : '已恢复（新建「恢复的章节」幕）',
        'success',
      );
      setPickingId(null);
      setTargetActId('');
      await onRestored();
    } catch {
      showToast('恢复失败，请检查后端连接', 'error');
    }
  };

  const handlePurge = async (trashId: number) => {
    if (!window.confirm('彻底删除后正文将不可恢复，确定？')) return;
    try {
      await purge(novelId, trashId);
      showToast('已彻底删除', 'info');
    } catch {
      showToast('操作失败，请检查后端连接', 'error');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="回收站" width="520px">
      <div className="px-5 py-4">
        <p className="text-[11px] text-neutral-500 leading-relaxed mb-3">
          删除的要点连同章节正文一起放在这里。恢复时可重新选择要归入的幕。
        </p>

        {loading && (
          <p className="py-8 text-center text-xs text-neutral-500">加载中…</p>
        )}

        {!loading && items.length === 0 && (
          <div className="py-10 flex flex-col items-center gap-2">
            <Trash2 size={28} className="text-neutral-700" />
            <p className="text-xs text-neutral-500">回收站是空的</p>
          </div>
        )}

        <div className="max-h-[380px] overflow-y-auto space-y-2">
          {items.map((it) => {
            const picking = pickingId === it.id;
            return (
              <div
                key={it.id}
                className="rounded-lg bg-white/4 border border-white/8 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium text-neutral-200 truncate">
                      {it.node_title || it.chapter_title || '未命名要点'}
                    </span>
                    <span className="block text-[10px] text-neutral-500 mt-0.5">
                      来自「{it.act_title || '已删除的幕'}」
                      {it.chapter_id
                        ? ` · ${it.chapter_title || '未命名章节'}${it.word_count ? ` · ${it.word_count.toLocaleString()} 字` : ''}`
                        : ' · 纯规划要点'}
                      {' · '}
                      {it.created_at}
                    </span>
                  </span>
                  {!picking && (
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => {
                          setPickingId(it.id);
                          setTargetActId('');
                        }}
                        title="恢复到大纲"
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-brand-500/15 text-brand-300 border border-brand-500/25 hover:bg-brand-500/25 transition-colors"
                      >
                        <RotateCcw size={11} />
                        恢复
                      </button>
                      <button
                        onClick={() => handlePurge(it.id)}
                        title="彻底删除"
                        className="p-1 rounded-md text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  )}
                </div>

                {/* 恢复：重选幕间归属 */}
                {picking && (
                  <div className="mt-2.5 pt-2.5 border-t border-white/8">
                    <p className="text-[10px] text-neutral-500 mb-1.5">选择恢复到哪一幕：</p>
                    <div className="flex items-center gap-2">
                      <select
                        value={targetActId}
                        onChange={(e) => setTargetActId(e.target.value)}
                        className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-brand-500/40"
                      >
                        <option value="" className="bg-neutral-800">
                          新建幕「恢复的章节」
                        </option>
                        {acts.map((a) => (
                          <option key={a.id} value={a.id} className="bg-neutral-800">
                            {a.title || '未命名幕'}（{a.nodes.length} 要点）
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleRestore(it.id)}
                        disabled={restoringId === it.id}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                      >
                        {restoringId === it.id ? '恢复中…' : (
                          <>
                            <Check size={12} />
                            确认恢复
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setPickingId(null);
                          setTargetActId('');
                        }}
                        className="px-2 py-1.5 rounded-lg text-xs text-neutral-400 hover:bg-white/8 transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};

export default TrashModal;
