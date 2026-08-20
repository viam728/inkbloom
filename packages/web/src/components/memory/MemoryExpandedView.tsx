import React, { useMemo } from 'react';
import { Pin } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { GROUP_CONFIG, GROUP_ORDER } from './memory-config';
import { sortMemoryItems, type MemoryItem } from '@/stores/memory-store';
import { htmlToPlainText } from '@/utils/html';

interface MemoryExpandedViewProps {
  open: boolean;
  onClose: () => void;
  /** 当前 scope 的全部条目（未过滤，由面板传入） */
  items: MemoryItem[];
  /**
   * 点击卡片：调用方需先关闭本大视图再打开编辑弹窗
   * （Modal Esc 为 window capture 监听，禁止嵌套打开）
   */
  onEdit: (item: MemoryItem) => void;
}

/** 记忆管理展开大视图：fullscreen 网格按分组分列平铺，卡片只读 */
const MemoryExpandedView: React.FC<MemoryExpandedViewProps> = ({ open, onClose, items, onEdit }) => {
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((type) => ({
        type,
        cfg: GROUP_CONFIG[type],
        items: sortMemoryItems(items.filter((i) => i.type === type)),
      })),
    [items],
  );

  return (
    <Modal open={open} onClose={onClose} fullscreen title="记忆管理 · 展开视图">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 p-4 items-start">
        {groups.map(({ type, cfg, items: groupItems }) => {
          const Icon = cfg.icon;
          return (
            <section key={type} className="flex flex-col gap-2 min-w-0">
              <header className="flex items-center gap-1.5 px-1">
                <Icon size={13} className={cfg.color} />
                <span className="text-xs font-semibold text-neutral-200">{cfg.label}</span>
                <span className="text-[10px] text-neutral-600">{groupItems.length}</span>
              </header>
              {groupItems.length === 0 ? (
                <p className="text-[11px] text-neutral-600 px-1 py-3">暂无条目</p>
              ) : (
                groupItems.map((item) => {
                  const preview = htmlToPlainText(item.content);
                  return (
                    <div
                      key={item.id}
                      onClick={() => onEdit(item)}
                      className="rounded-lg border border-white/6 bg-white/3 px-3 py-2.5 cursor-pointer hover:border-white/15 hover:bg-white/5 transition-colors"
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        {item.pinned && (
                          /* 置顶 / AI 优先 */
                          <Pin size={10} className="text-brand-300 shrink-0" />
                        )}
                        <span className="flex-1 text-xs font-medium text-neutral-200 truncate">{item.name}</span>
                        {item.ai_visible === false && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-white/6 text-neutral-500">AI 不可见</span>
                        )}
                      </div>
                      {preview && (
                        <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-4">{preview}</p>
                      )}
                      {item.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {item.tags.map((tag) => (
                            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/6 text-neutral-500">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
};

export default MemoryExpandedView;
