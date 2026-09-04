import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  ListOrdered,
  Maximize2,
  FileText,
  Send,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useOutlineStore,
  OUTLINE_STATUS_LABELS,
  toggleWritingStatus,
  type OutlineAct,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { trashNode } from '@/services/trash-client';
import { useTrashStore } from '@/stores/trash-store';
import { usePublishStore } from '@/stores/publish-store';
import { useTabStore } from '@/stores/tab-store';
import { useToast } from '@/components/common/Toast';
import Modal from '@/components/common/Modal';
import { htmlToPlainText } from '@/utils/html';
import OutlineExpandedView from './OutlineExpandedView';
import TrashModal from './TrashModal';

/** 稳定引用的空数组，避免 selector 每次返回新引用导致无限渲染 */
const EMPTY_ACTS: OutlineAct[] = [];

const STATUS_CONFIG: Record<
  OutlineStatus,
  { dot: string; text: string; chip: string }
> = {
  drafting: {
    dot: 'bg-amber-400',
    text: 'text-amber-400',
    chip: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
  },
  done: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
    chip: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  },
  published: {
    dot: 'bg-sky-400',
    text: 'text-sky-400',
    chip: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
  },
};

/** 结构化创作面板：大纲（幕 → 章节要点）→ AI 扩写 → 成稿章节。
 *  要点编辑器为中央标签页（OutlineNodeEditor），不再使用弹窗。 */
const OutlinePanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const { createChapter, selectChapter, fetchChapters } = useNovelStore();
  const loadTrash = useTrashStore((s) => s.load);

  const acts = useOutlineStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] ?? EMPTY_ACTS : EMPTY_ACTS,
  );
  const {
    loadOutline,
    addAct,
    updateAct,
    removeAct,
    addNode,
    updateNode,
  } = useOutlineStore();

  const { showToast } = useToast();

  const [collapsedActs, setCollapsedActs] = useState<Set<string>>(new Set());
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  // ── 幕重命名弹窗 ─────────────────────────────────────────────────────
  const [editingAct, setEditingAct] = useState<OutlineAct | null>(null);
  const [actTitleDraft, setActTitleDraft] = useState('');

  const novelId = currentNovel?.id;

  // 发布状态系统事实：published_chapters 表（章节级），刷新后依然生效
  const pubChapters = usePublishStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id]?.chapters : undefined,
  );
  const publishedChapterIds = useMemo(
    () => new Set((pubChapters ?? []).map((c) => c.chapter_id)),
    [pubChapters],
  );

  useEffect(() => {
    if (novelId) {
      loadOutline(novelId);
      void usePublishStore.getState().load(novelId);
    }
  }, [novelId, loadOutline]);

  const toggleAct = (id: string) => {
    setCollapsedActs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddAct = () => {
    if (!novelId) return;
    const act = addAct(novelId, '');
    // 新建的幕直接弹窗命名
    if (act) {
      setEditingAct(act);
      setActTitleDraft(act.title);
    }
  };

  /** 要点编辑器 = 中央标签页（key 按节点 id 稳定，重开即激活） */
  const openNodeEditor = (actId: string, node: OutlineNode) => {
    useTabStore.getState().openPanelTab(
      `outline-node-${node.id}`,
      node.title || '未命名章节',
      'outline-node',
      { actId, nodeId: node.id, novelId },
    );
  };

  const handleAddNode = (actId: string) => {
    if (!novelId) return;
    const node = addNode(novelId, actId);
    setCollapsedActs((prev) => {
      const next = new Set(prev);
      next.delete(actId);
      return next;
    });
    openNodeEditor(actId, node);
  };

  /**
   * 正文入口（大纲 ↔ 章节合并后的唯一出口）：
   * 已关联成稿章节 → 直接打开该章节正文；未关联 → 按大纲顺序就地建一章
   * 空正文并关联后打开。
   */
  const handleOpenBody = async (actId: string, node: OutlineNode) => {
    if (!novelId) return;
    const linked = node.chapter_id ? chapters.find((c) => c.id === node.chapter_id) : undefined;
    if (linked) {
      await selectChapter(linked);
      return;
    }
    const title = node.title?.trim() || '未命名章节';
    try {
      // 按大纲顺序计算插入位置：统计目标要点之前、已成稿且章节仍存在的要点数量
      let insertAt = 0;
      let found = false;
      for (const act of acts) {
        for (const n of act.nodes) {
          if (act.id === actId && n.id === node.id) {
            found = true;
            break;
          }
          if (n.chapter_id && chapters.some((c) => c.id === n.chapter_id)) insertAt++;
        }
        if (found) break;
      }
      const chapter = await createChapter({ novel_id: novelId, title, content: '' }, insertAt);
      updateNode(novelId, actId, node.id, {
        chapter_id: chapter.id,
        status: node.status === 'done' || node.status === 'published' ? node.status : 'drafting',
      });
      await selectChapter(chapter);
      showToast(`已为「${title}」创建正文，可直接开写`, 'success');
    } catch {
      showToast('创建正文章节失败，请检查后端连接', 'error');
    }
  };

  /** 删除幕（垃圾桶）：幕下全部要点逐个进桶，再移除空幕 */
  const handleRemoveAct = async (act: OutlineAct) => {
    if (!novelId) return;
    const boundCount = act.nodes.filter((n) => n.chapter_id).length;
    if (
      act.nodes.length > 0 &&
      !window.confirm(
        `「${act.title || '未命名幕'}」下 ${act.nodes.length} 个要点${boundCount ? `（含 ${boundCount} 章正文）` : ''}将全部移入回收站，可随时恢复，确定？`,
      )
    ) {
      return;
    }
    let failed = false;
    for (const n of act.nodes) {
      try {
        await trashNode(novelId, act.id, n.id);
      } catch {
        failed = true;
        break;
      }
    }
    if (!failed) {
      // 空幕从本地移除并 PUT（loadOutline 已同步到服务端最新 version）
      removeAct(novelId, act.id);
      showToast('幕已删除，要点移入回收站', 'info');
    } else {
      showToast('部分要点删除失败', 'error');
    }
    await loadOutline(novelId);
    await fetchChapters(novelId);
  };

  /** 节点卡两态切换：写作中 ↔ 已完成（已发布节点由系统管理，按钮禁用） */
  const handleToggleNodeStatus = (actId: string, node: OutlineNode) => {
    if (!novelId || node.status === 'published') return;
    if (node.chapter_id != null && publishedChapterIds.has(node.chapter_id)) return;
    updateNode(novelId, actId, node.id, { status: toggleWritingStatus(node.status) });
  };

  // ── 空态与进度 ────────────────────────────────────────────────────────
  if (!currentNovel) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500/20 to-fuchsia-500/20 flex items-center justify-center mb-3">
          <ListOrdered size={22} className="text-brand-400/70" />
        </div>
        <p className="text-sm text-neutral-400 mb-1">先选择一部作品</p>
        <p className="text-[11px] text-neutral-600 leading-relaxed">
          在大纲中规划幕与章节要点
          <br />
          再一键扩写成稿
        </p>
      </div>
    );
  }

  const totalNodes = acts.reduce((sum, a) => sum + a.nodes.length, 0);
  const doneNodes = acts.reduce(
    (sum, a) =>
      sum +
      a.nodes.filter(
        (n) => n.status === 'done' || n.status === 'published' || (n.chapter_id != null && publishedChapterIds.has(n.chapter_id)),
      ).length,
    0,
  );
  const progress = totalNodes ? Math.round((doneNodes / totalNodes) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      {/* 进度概览 */}
      <div className="px-3.5 pt-2.5 pb-2 border-b border-white/6">
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            <ListOrdered size={11} />
            创作蓝图
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-neutral-500 tabular-nums">
              {doneNodes}/{totalNodes} 章完成 · {progress}%
            </span>
            <button
              onClick={() => {
                setTrashOpen(true);
                if (novelId) loadTrash(novelId);
              }}
              title="回收站"
              className="p-0.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
            >
              <Trash2 size={12} />
            </button>
            <button
              onClick={() => setExpandedOpen(true)}
              title="大纲管理 · 展开视图"
              className="p-0.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
            >
              <Maximize2 size={12} />
            </button>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-fuchsia-500 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* 大纲树 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2.5 py-2">
        {acts.length === 0 && (
          <div className="mt-6 flex flex-col items-center text-center px-4">
            <p className="text-xs text-neutral-500 mb-3 leading-relaxed">
              还没有大纲。
              <br />
              从「第一幕」开始规划你的故事结构
            </p>
            <button
              onClick={handleAddAct}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 transition-all shadow-lg shadow-brand-600/20"
            >
              <Plus size={13} />
              创建第一幕
            </button>
          </div>
        )}

        {acts.map((act) => (
          <ActBlock
            key={act.id}
            act={act}
            collapsed={collapsedActs.has(act.id)}
            publishedIds={publishedChapterIds}
            onToggle={() => toggleAct(act.id)}
            onRename={() => {
              setEditingAct(act);
              setActTitleDraft(act.title);
            }}
            onRemove={() => handleRemoveAct(act)}
            onAddNode={() => handleAddNode(act.id)}
            onEditNode={(node) => openNodeEditor(act.id, node)}
            onOpenBody={(node) => handleOpenBody(act.id, node)}
            onToggleNodeStatus={(node) => handleToggleNodeStatus(act.id, node)}
          />
        ))}

        {acts.length > 0 && (
          <button
            onClick={handleAddAct}
            className="w-full mt-1.5 mb-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-white/10 text-neutral-500 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/5 transition-colors text-xs"
          >
            <Plus size={13} />
            添加新一幕
          </button>
        )}
      </div>

      {/* 幕重命名弹窗 */}
      <Modal
        open={editingAct !== null}
        onClose={() => setEditingAct(null)}
        title="重命名幕"
      >
        <div className="px-5 py-4">
          <input
            value={actTitleDraft}
            onChange={(e) => setActTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && novelId && editingAct && actTitleDraft.trim()) {
                updateAct(novelId, editingAct.id, actTitleDraft.trim());
                setEditingAct(null);
              }
            }}
            placeholder="幕标题（如：第一幕 · 雨夜来信）"
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setEditingAct(null)}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (novelId && editingAct && actTitleDraft.trim()) {
                  updateAct(novelId, editingAct.id, actTitleDraft.trim());
                }
                setEditingAct(null);
              }}
              disabled={!actTitleDraft.trim()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              保存
            </button>
          </div>
        </div>
      </Modal>

      {/* 展开大视图：点击卡片打开中央要点编辑 tab */}
      <OutlineExpandedView
        open={expandedOpen}
        onClose={() => setExpandedOpen(false)}
        acts={acts}
        publishedIds={publishedChapterIds}
        onEditNode={(actId, node) => {
          setExpandedOpen(false);
          openNodeEditor(actId, node);
        }}
      />

      {/* 回收站：恢复时重选幕间归属 */}
      {currentNovel && (
        <TrashModal
          open={trashOpen}
          novelId={currentNovel.id}
          acts={acts}
          onClose={() => setTrashOpen(false)}
          onRestored={async () => {
            if (!novelId) return;
            await loadOutline(novelId);
            await fetchChapters(novelId);
          }}
        />
      )}
    </div>
  );
};

// ── 幕区块 ──────────────────────────────────────────────────────────────
interface ActBlockProps {
  act: OutlineAct;
  collapsed: boolean;
  /** 发布状态的系统事实：已发布章节 id 集（published_chapters 表） */
  publishedIds: Set<number>;
  onToggle: () => void;
  onRename: () => void;
  onRemove: () => void;
  onAddNode: () => void;
  onEditNode: (node: OutlineNode) => void;
  onOpenBody: (node: OutlineNode) => void;
  onToggleNodeStatus: (node: OutlineNode) => void;
}

const ActBlock: React.FC<ActBlockProps> = ({
  act,
  collapsed,
  publishedIds,
  onToggle,
  onRename,
  onRemove,
  onAddNode,
  onEditNode,
  onOpenBody,
  onToggleNodeStatus,
}) => {
  return (
    <div className="mb-2">
      {/* 幕标题行 */}
      <div className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-white/4 transition-colors">
        <button
          onClick={onToggle}
          className="shrink-0 p-0.5 text-neutral-500 hover:text-neutral-300 transition-colors"
          title={collapsed ? '展开' : '收起'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>

        <button
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
        >
          <span className="text-xs font-semibold text-neutral-200 truncate">{act.title}</span>
          <span className="text-[10px] text-neutral-600 shrink-0">{act.nodes.length} 章</span>
        </button>

        {/* 幕操作 */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onAddNode}
            title="添加章节要点"
            className="p-1 rounded text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={onRename}
            title="重命名"
            className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={onRemove}
            title="删除幕"
            className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* 章节节点 */}
      {!collapsed && (
        <div className="ml-3 pl-2 border-l border-white/6 space-y-1 pb-1">
          {act.nodes.length === 0 && (
            <button
              onClick={onAddNode}
              className="w-full px-3 py-2 rounded-lg border border-dashed border-white/8 text-neutral-600 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/5 transition-colors text-[11px]"
            >
              + 添加章节要点
            </button>
          )}
          {act.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              publishedIds={publishedIds}
              onEdit={() => onEditNode(node)}
              onOpenBody={() => onOpenBody(node)}
              onToggleStatus={() => onToggleNodeStatus(node)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── 章节要点卡片（点击打开中央要点编辑 tab，状态标签为两态切换按钮） ─────
interface NodeCardProps {
  node: OutlineNode;
  publishedIds: Set<number>;
  onEdit: () => void;
  onOpenBody: () => void;
  onToggleStatus: () => void;
}

const NodeCard: React.FC<NodeCardProps> = ({ node, publishedIds, onEdit, onOpenBody, onToggleStatus }) => {
  const hasBody = Boolean(node.chapter_id);
  // 已发布 = 系统事实（published_chapters）或节点状态标记，二者任一即视为已发布
  const isPublished =
    node.status === 'published' || (node.chapter_id != null && publishedIds.has(node.chapter_id));
  // 写作状态 chip 恒为两态（写作中/已完成）：已发布由独立图标承担，不挤占状态位
  const writingStatus: OutlineStatus = isPublished || node.status === 'published' ? 'done' : node.status;
  const status = STATUS_CONFIG[writingStatus] ?? STATUS_CONFIG.drafting;
  return (
    <div
      onClick={onEdit}
      className="group relative px-3 py-2 rounded-lg bg-surface-2 border border-white/6 hover:border-brand-500/30 cursor-pointer transition-all"
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${status.dot}`} />
        <span className="flex-1 min-w-0 text-xs text-neutral-200 truncate">
          {node.title || '未命名章节'}
        </span>
        {/* 已发布独立图标位：发布状态由系统管理，与写作状态分离展示 */}
        {isPublished && (
          <span
            title="已发布（发布状态由系统管理）"
            className="shrink-0 flex items-center justify-center w-4 h-4 rounded bg-sky-500/15 text-sky-300 border border-sky-500/25"
          >
            <Send size={9} />
          </span>
        )}
        {/* 写作状态两态切换（写作中 ↔ 已完成） */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!isPublished) onToggleStatus();
          }}
          disabled={isPublished}
          title={isPublished ? '已发布章节的写作状态视为已完成' : '点击切换写作状态'}
          className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border transition-colors ${status.chip} ${
            isPublished ? 'cursor-default' : 'hover:brightness-125'
          }`}
        >
          {OUTLINE_STATUS_LABELS[writingStatus] ?? OUTLINE_STATUS_LABELS.drafting}
        </button>
      </div>
      {/* 正文入口（章名下方常驻，大纲与章节的交互合并——有正文就打开，没正文就建一章再打开） */}
      <div className="mt-1.5 pl-3.5 flex items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenBody();
          }}
          title={hasBody ? '打开正文章节' : '创建并打开正文章节'}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-brand-500/12 text-brand-200 border border-brand-500/25 hover:bg-brand-500/25 hover:text-white transition-colors"
        >
          <FileText size={11} />
          {hasBody ? '正文' : '写正文'}
        </button>
      </div>
      {node.summary && (
        <p className="mt-1 text-[11px] text-neutral-500 line-clamp-2 pl-3.5">{htmlToPlainText(node.summary)}</p>
      )}
    </div>
  );
};

export default OutlinePanel;
