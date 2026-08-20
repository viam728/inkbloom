import React from 'react';
import { BookOpen } from 'lucide-react';
import Modal from '@/components/common/Modal';
import type { Novel } from '@/types';

interface LibraryExpandedViewProps {
  open: boolean;
  onClose: () => void;
  novels: Novel[];
  currentNovelId?: number;
  /** 点击卡片：调用方选中作品并关闭本大视图 */
  onSelect: (novel: Novel) => void;
}

const fmtTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

/** 作品库展开大视图：fullscreen 网格卡片，点击选中作品 */
const LibraryExpandedView: React.FC<LibraryExpandedViewProps> = ({
  open,
  onClose,
  novels,
  currentNovelId,
  onSelect,
}) => {
  return (
    <Modal open={open} onClose={onClose} fullscreen title="作品库 · 展开视图">
      {novels.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-xs text-neutral-500 leading-relaxed">
            还没有作品。
            <br />
            回到列表创建你的第一部作品
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 p-4 items-start">
          {novels.map((novel) => {
            const active = currentNovelId === novel.id;
            return (
              <div
                key={novel.id}
                onClick={() => onSelect(novel)}
                className={`rounded-xl border p-4 cursor-pointer transition-all ${
                  active
                    ? 'bg-gradient-to-br from-brand-600/15 to-fuchsia-600/8 border-brand-500/35'
                    : 'bg-white/3 border-white/6 hover:border-white/15 hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                      active ? 'bg-brand-500/20 text-brand-300' : 'bg-white/5 text-neutral-500'
                    }`}
                  >
                    <BookOpen size={15} />
                  </span>
                  <span className="flex-1 min-w-0 text-sm font-medium text-neutral-200 truncate">
                    {novel.title}
                  </span>
                  {active && (
                    <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/12 text-brand-300 border border-brand-500/25">
                      当前
                    </span>
                  )}
                </div>
                {novel.description ? (
                  <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-3 mb-2">
                    {novel.description}
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-600 mb-2">暂无简介</p>
                )}
                <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                  {novel.genre && <span className="px-1.5 py-0.5 rounded bg-white/5">{novel.genre}</span>}
                  <span className="tabular-nums">
                    {novel.word_count ? `${novel.word_count.toLocaleString()} 字` : '尚未开始'}
                  </span>
                  <span className="ml-auto tabular-nums">更新于 {fmtTime(novel.updated_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};

export default LibraryExpandedView;
