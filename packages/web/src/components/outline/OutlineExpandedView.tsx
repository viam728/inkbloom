import React from 'react';
import { Link2, Send } from 'lucide-react';
import Modal from '@/components/common/Modal';
import {
  OUTLINE_STATUS_LABELS,
  type OutlineAct,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { htmlToPlainText } from '@/utils/html';

const STATUS_CONFIG: Record<OutlineStatus, { dot: string; chip: string }> = {
  drafting: {
    dot: 'bg-amber-400',
    chip: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
  },
  done: {
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  },
  published: {
    dot: 'bg-sky-400',
    chip: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
  },
};

interface OutlineExpandedViewProps {
  open: boolean;
  onClose: () => void;
  acts: OutlineAct[];
  /** 发布状态系统事实：已发布章节 id 集（published_chapters 表） */
  publishedIds: Set<number>;
  /**
   * 点击节点卡：调用方需先关闭本大视图再打开编辑弹窗
   * （Modal Esc 为 window capture 监听，禁止嵌套打开）
   */
  onEditNode: (actId: string, node: OutlineNode) => void;
}

/** 大纲展开大视图：fullscreen 幕分栏网格，节点卡平铺（复用 NodeCard 样式元素）。
 *  已发布用独立 Send 图标位展示，写作状态 chip 恒为两态，与节点卡一致。 */
const OutlineExpandedView: React.FC<OutlineExpandedViewProps> = ({
  open,
  onClose,
  acts,
  publishedIds,
  onEditNode,
}) => {
  return (
    <Modal open={open} onClose={onClose} fullscreen title="创作蓝图 · 展开视图">
      {acts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-xs text-neutral-500 leading-relaxed">
            还没有大纲。
            <br />
            回到面板从「第一幕」开始规划你的故事结构
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-4 items-start">
          {acts.map((act) => (
            <section key={act.id} className="flex flex-col gap-2 min-w-0">
              <header className="flex items-center gap-1.5 px-1">
                <span className="text-xs font-semibold text-neutral-200 truncate">{act.title}</span>
                <span className="text-[10px] text-neutral-600 shrink-0">{act.nodes.length} 章</span>
              </header>
              {act.nodes.length === 0 ? (
                <p className="text-[11px] text-neutral-600 px-1 py-3">暂无章节要点</p>
              ) : (
                act.nodes.map((node) => {
                  const isPublished =
                    node.status === 'published' ||
                    (node.chapter_id != null && publishedIds.has(node.chapter_id));
                  // 写作状态 chip 恒为两态；已发布由独立图标承担
                  const writingStatus: OutlineStatus =
                    isPublished || node.status === 'published' ? 'done' : node.status;
                  const status = STATUS_CONFIG[writingStatus] ?? STATUS_CONFIG.drafting;
                  const preview = htmlToPlainText(node.summary);
                  return (
                    <div
                      key={node.id}
                      onClick={() => onEditNode(act.id, node)}
                      className="rounded-lg bg-surface-2 border border-white/6 px-3 py-2 hover:border-brand-500/30 cursor-pointer transition-all"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${status.dot}`} />
                        <span className="flex-1 min-w-0 text-xs text-neutral-200 truncate">
                          {node.title || '未命名章节'}
                        </span>
                        {node.chapter_id && (
                          <span
                            title="已关联成稿章节"
                            className="shrink-0 flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/12 text-brand-300 border border-brand-500/20"
                          >
                            <Link2 size={9} />
                            成稿
                          </span>
                        )}
                        {isPublished && (
                          <span
                            title="已发布（发布状态由系统管理）"
                            className="shrink-0 flex items-center justify-center w-4 h-4 rounded bg-sky-500/15 text-sky-300 border border-sky-500/25"
                          >
                            <Send size={9} />
                          </span>
                        )}
                        <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border ${status.chip}`}>
                          {OUTLINE_STATUS_LABELS[writingStatus] ?? OUTLINE_STATUS_LABELS.drafting}
                        </span>
                      </div>
                      {preview && (
                        <p className="mt-1 text-[11px] text-neutral-500 line-clamp-3 pl-3.5">{preview}</p>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default OutlineExpandedView;
