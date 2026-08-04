import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Link2,
  ListOrdered,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useMemoryStore, sortMemoryItems } from '@/stores/memory-store';
import {
  useOutlineStore,
  OUTLINE_STATUS_LABELS,
  type OutlineAct,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { expandOutlineToDraft } from '@/services/outline-client';
import { useToast } from '@/components/common/Toast';
import Modal from '@/components/common/Modal';
import DraftPreviewModal from './DraftPreviewModal';

/** 稳定引用的空数组，避免 selector 每次返回新引用导致无限渲染 */
const EMPTY_ACTS: OutlineAct[] = [];

const STATUS_CONFIG: Record<
  OutlineStatus,
  { dot: string; text: string; chip: string }
> = {
  planned: {
    dot: 'bg-neutral-500',
    text: 'text-neutral-500',
    chip: 'bg-white/6 text-neutral-400 border-white/10',
  },
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
};

/** 结构化创作面板：大纲（幕 → 章节要点）→ AI 扩写 → 成稿章节 */
const OutlinePanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const { createChapter, selectChapter } = useNovelStore();

  const acts = useOutlineStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] ?? EMPTY_ACTS : EMPTY_ACTS,
  );
  const {
    loadOutline,
    addAct,
    updateAct,
    removeAct,
    moveAct,
    addNode,
    updateNode,
    removeNode,
    moveNode,
  } = useOutlineStore();

  const { showToast } = useToast();

  const [collapsedActs, setCollapsedActs] = useState<Set<string>>(new Set());

  // ── 弹窗编辑（替代左栏内联展开） ─────────────────────────────────────
  const [editingNode, setEditingNode] = useState<{ actId: string; node: OutlineNode } | null>(null);
  const [nodeTitleDraft, setNodeTitleDraft] = useState('');
  const [nodeSummaryDraft, setNodeSummaryDraft] = useState('');
  const [editingAct, setEditingAct] = useState<OutlineAct | null>(null);
  const [actTitleDraft, setActTitleDraft] = useState('');

  // 扩写 → 初稿预览状态
  const [expandTarget, setExpandTarget] = useState<{
    actId: string;
    node: OutlineNode;
  } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftRefs, setDraftRefs] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);

  const novelId = currentNovel?.id;

  useEffect(() => {
    if (novelId) loadOutline(novelId);
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

  const handleAddNode = (actId: string) => {
    if (!novelId) return;
    const node = addNode(novelId, actId);
    setCollapsedActs((prev) => {
      const next = new Set(prev);
      next.delete(actId);
      return next;
    });
    setEditingNode({ actId, node });
    setNodeTitleDraft(node.title);
    setNodeSummaryDraft(node.summary);
  };

  const openNodeEditor = (actId: string, node: OutlineNode) => {
    setEditingNode({ actId, node });
    setNodeTitleDraft(node.title);
    setNodeSummaryDraft(node.summary);
  };

  const closeNodeEditor = () => {
    setEditingNode(null);
    setNodeTitleDraft('');
    setNodeSummaryDraft('');
  };

  const commitNodeEdit = (patch?: Partial<OutlineNode>) => {
    if (!novelId || !editingNode) return;
    updateNode(novelId, editingNode.actId, editingNode.node.id, {
      title: nodeTitleDraft.trim(),
      summary: nodeSummaryDraft.trim(),
      ...patch,
    });
  };

  // ── 大纲 → 成稿：AI 扩写 ─────────────────────────────────────────────
  const handleExpand = async (actId: string, node: OutlineNode) => {
    if (!novelId) return;
    setEditingNode(null);
    setExpandTarget({ actId, node });
    setDraft(null);
    setDraftRefs([]);

    // 注入作品记忆（人物/设定）作为上下文
    let refs: string[] = [];
    try {
      const mem = useMemoryStore.getState();
      if (!mem.byNovel[novelId]) await mem.loadMemory(novelId);
      const items = useMemoryStore.getState().byNovel[novelId] ?? [];
      // 置顶条目优先携带，保证 AI 扩写贴合核心设定
      refs = sortMemoryItems(items)
        .filter((i) => i.type === 'character' || i.type === 'setting')
        .map((i) => i.name)
        .slice(0, 6);
    } catch {
      /* 无设定也可扩写 */
    }

    try {
      const text = await expandOutlineToDraft({
        outlineTitle: node.title || '未命名章节',
        summary: node.summary,
        memoryContext: refs,
      });
      setDraftRefs(refs);
      setDraft(text);
    } catch {
      showToast('扩写失败，请重试', 'error');
      setExpandTarget(null);
    }
  };

  /**
   * 按大纲顺序计算新章节在成稿序列中的插入位置：
   * 统计目标要点之前、且已扩写成稿（章节仍存在）的要点数量。
   * 例：两幕各有一章成稿时，为第一幕新增的要点将插入到第二幕章节之前。
   */
  const computeInsertAt = (actId: string, nodeId: string): number => {
    let count = 0;
    for (const act of acts) {
      for (const n of act.nodes) {
        if (act.id === actId && n.id === nodeId) return count;
        if (n.chapter_id && chapters.some((c) => c.id === n.chapter_id)) count++;
      }
    }
    return count;
  };

  // ── 初稿 → 创建章节并写入（按大纲顺序插入） ───────────────────────────
  const handleWriteDraft = async () => {
    if (!novelId || !expandTarget || !draft) return;
    setWriting(true);
    try {
      const title = expandTarget.node.title || '未命名章节';
      const insertAt = computeInsertAt(expandTarget.actId, expandTarget.node.id);
      const chapter = await createChapter(
        { novel_id: novelId, title, content: draft },
        insertAt,
      );
      updateNode(novelId, expandTarget.actId, expandTarget.node.id, {
        chapter_id: chapter.id,
        status: 'drafting',
        memory_refs: draftRefs,
      });
      // 直接带内容跳转，编辑器即刻可见初稿
      useNovelStore.setState({ currentChapter: { ...chapter, content: draft } });
      showToast(`初稿已写入章节「${title}」（第 ${insertAt + 1} 章）`, 'success');
      setExpandTarget(null);
      setDraft(null);
    } catch {
      showToast('后端未连接，无法创建章节，可先复制初稿', 'error');
    } finally {
      setWriting(false);
    }
  };

  const handleJumpChapter = async (node: OutlineNode) => {
    const chapter = chapters.find((c) => c.id === node.chapter_id);
    if (chapter) {
      await selectChapter(chapter);
    } else {
      showToast('关联章节已不存在', 'error');
    }
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
    (sum, a) => sum + a.nodes.filter((n) => n.status === 'done').length,
    0,
  );
  const progress = totalNodes ? Math.round((doneNodes / totalNodes) * 100) : 0;

  const editingNodeLive = editingNode
    ? acts.find((a) => a.id === editingNode.actId)?.nodes.find((n) => n.id === editingNode.node.id) ?? null
    : null;
  const editingNodeIdx = editingNodeLive
    ? acts.find((a) => a.id === editingNode!.actId)?.nodes.findIndex((n) => n.id === editingNodeLive.id) ?? -1
    : -1;
  const editingNodeCount = editingNodeLive
    ? acts.find((a) => a.id === editingNode!.actId)?.nodes.length ?? 0
    : 0;

  return (
    <div className="flex flex-col h-full">
      {/* 进度概览 */}
      <div className="px-3.5 pt-2.5 pb-2 border-b border-white/6">
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            <ListOrdered size={11} />
            创作蓝图
          </span>
          <span className="text-[10px] text-neutral-500 tabular-nums">
            {doneNodes}/{totalNodes} 章完成 · {progress}%
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

        {acts.map((act, actIdx) => (
          <ActBlock
            key={act.id}
            act={act}
            actIdx={actIdx}
            actCount={acts.length}
            collapsed={collapsedActs.has(act.id)}
            onToggle={() => toggleAct(act.id)}
            onRename={() => {
              setEditingAct(act);
              setActTitleDraft(act.title);
            }}
            onRemove={() => {
              if (novelId) removeAct(novelId, act.id);
              showToast('已删除幕', 'info');
            }}
            onMove={(dir) => novelId && moveAct(novelId, act.id, dir)}
            onAddNode={() => handleAddNode(act.id)}
            onEditNode={(node) => openNodeEditor(act.id, node)}
            onExpandNode={(node) => handleExpand(act.id, node)}
            onJumpNode={handleJumpChapter}
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

      {/* 章节要点编辑弹窗（替代左栏内联展开，空间更宽裕） */}
      <Modal
        open={editingNode !== null}
        onClose={closeNodeEditor}
        title="编辑章节要点"
        width="480px"
      >
        {editingNodeLive && (
          <div className="px-5 py-4">
            <input
              value={nodeTitleDraft}
              onChange={(e) => setNodeTitleDraft(e.target.value)}
              placeholder="章节标题（将用于成稿章节名）"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
            />
            <textarea
              value={nodeSummaryDraft}
              onChange={(e) => setNodeSummaryDraft(e.target.value)}
              placeholder={'剧情要点，每行一条：\n主角在雨夜发现密信\n与旧友摊牌……'}
              rows={5}
              className="mt-2.5 w-full px-3 py-2 rounded-lg bg-white/5 text-[13px] leading-6 text-neutral-200 border border-white/10 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 resize-none placeholder-neutral-500 transition-all"
            />

            {/* 状态选择 */}
            <div className="flex items-center gap-1.5 mt-3">
              <span className="text-[11px] text-neutral-500 mr-1">状态</span>
              {(Object.keys(OUTLINE_STATUS_LABELS) as OutlineStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => commitNodeEdit({ status: s })}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    editingNodeLive.status === s
                      ? STATUS_CONFIG[s].chip
                      : 'bg-white/4 text-neutral-500 border-white/8 hover:text-neutral-300'
                  }`}
                >
                  {OUTLINE_STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            {/* 操作行 */}
            <div className="flex items-center gap-1.5 mt-4">
              <button
                onClick={() => {
                  commitNodeEdit();
                  handleExpand(editingNode!.actId, {
                    ...editingNodeLive,
                    title: nodeTitleDraft.trim(),
                    summary: nodeSummaryDraft.trim(),
                  });
                }}
                disabled={!nodeSummaryDraft.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:opacity-40 transition-all shadow-lg shadow-brand-600/20"
              >
                <Sparkles size={12} />
                扩写成稿
              </button>
              <div className="flex-1" />
              <button
                onClick={() => novelId && moveNode(novelId, editingNode!.actId, editingNodeLive.id, -1)}
                disabled={editingNodeIdx === 0}
                title="在大纲中上移"
                className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
              >
                <ArrowUp size={13} />
              </button>
              <button
                onClick={() => novelId && moveNode(novelId, editingNode!.actId, editingNodeLive.id, 1)}
                disabled={editingNodeIdx >= editingNodeCount - 1}
                title="在大纲中下移"
                className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
              >
                <ArrowDown size={13} />
              </button>
              <button
                onClick={() => {
                  if (novelId) removeNode(novelId, editingNode!.actId, editingNodeLive.id);
                  closeNodeEditor();
                  showToast('已删除章节要点', 'info');
                }}
                title="删除要点"
                className="p-1.5 rounded-md text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={13} />
              </button>
              <button
                onClick={() => {
                  commitNodeEdit();
                  closeNodeEditor();
                }}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white transition-all shadow-lg shadow-indigo-600/20"
              >
                保存
              </button>
            </div>
          </div>
        )}
      </Modal>

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

      {/* 扩写初稿预览 */}
      <DraftPreviewModal
        open={expandTarget !== null}
        title={expandTarget?.node.title || ''}
        draft={draft}
        memoryRefs={draftRefs}
        writing={writing}
        onClose={() => {
          setExpandTarget(null);
          setDraft(null);
        }}
        onWrite={handleWriteDraft}
      />
    </div>
  );
};

// ── 幕区块 ──────────────────────────────────────────────────────────────
interface ActBlockProps {
  act: OutlineAct;
  actIdx: number;
  actCount: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onAddNode: () => void;
  onEditNode: (node: OutlineNode) => void;
  onExpandNode: (node: OutlineNode) => void;
  onJumpNode: (node: OutlineNode) => void;
}

const ActBlock: React.FC<ActBlockProps> = ({
  act,
  actIdx,
  actCount,
  collapsed,
  onToggle,
  onRename,
  onRemove,
  onMove,
  onAddNode,
  onEditNode,
  onExpandNode,
  onJumpNode,
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
            onClick={() => onMove(-1)}
            disabled={actIdx === 0}
            title="上移"
            className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
          >
            <ArrowUp size={11} />
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={actIdx === actCount - 1}
            title="下移"
            className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
          >
            <ArrowDown size={11} />
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
              onEdit={() => onEditNode(node)}
              onExpand={() => onExpandNode(node)}
              onJump={() => onJumpNode(node)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── 章节要点卡片（点击弹窗编辑） ────────────────────────────────────────
interface NodeCardProps {
  node: OutlineNode;
  onEdit: () => void;
  onExpand: () => void;
  onJump: () => void;
}

const NodeCard: React.FC<NodeCardProps> = ({ node, onEdit, onExpand, onJump }) => {
  const status = STATUS_CONFIG[node.status];
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
        {node.chapter_id && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onJump();
            }}
            title="跳转到成稿章节"
            className="shrink-0 flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/12 text-brand-300 border border-brand-500/20 hover:bg-brand-500/25 transition-colors"
          >
            <Link2 size={9} />
            成稿
          </span>
        )}
        <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full border ${status.chip}`}>
          {OUTLINE_STATUS_LABELS[node.status]}
        </span>
      </div>
      {node.summary && (
        <p className="mt-1 text-[11px] text-neutral-500 line-clamp-2 pl-3.5">{node.summary}</p>
      )}
      {/* 悬停快捷操作 */}
      <div className="absolute top-1.5 right-1.5 hidden group-hover:flex items-center gap-0.5 bg-surface-2 rounded-md">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="编辑要点"
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
          title="AI 扩写成稿"
          className="p-1 rounded text-fuchsia-300 hover:bg-fuchsia-500/15 transition-colors"
        >
          <Sparkles size={12} />
        </button>
      </div>
    </div>
  );
};

export default OutlinePanel;
