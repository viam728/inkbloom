import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  MoreHorizontal,
} from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useOutlineStore,
  type OutlineAct,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { usePublishStore } from '@/stores/publish-store';
import { useTabStore } from '@/stores/tab-store';
import { useUIStore } from '@/stores/ui-store';
import { useToast } from '@/components/common/Toast';
import { confirmDialog } from '@/components/common/ConfirmDialog';
import Modal from '@/components/common/Modal';
import { htmlToPlainText } from '@/utils/html';
import { toChineseNumeral } from '@/utils/cn-numeral';
import OutlineExpandedView from './OutlineExpandedView';

/** 稳定引用的空数组，避免 selector 每次返回新引用导致无限渲染 */
const EMPTY_ACTS: OutlineAct[] = [];

/** 写作状态圆点（展示用）：发布态解耦后，列表只呈现写作中/已完成 */
const STATUS_DOT: Record<OutlineStatus, string> = {
  drafting: 'bg-amber-400',
  done: 'bg-emerald-400',
  published: 'bg-emerald-400',
};

/**
 * 顺序标签（备忘录 L61）：绑定大纲次序、不写入标题文本；点击循环三种渲染：
 * 第一卷/章（中文，默认）/ 1（数字）/ 不含文字的节点标（无文字小标记）。
 * 节点用「章」、卷用「卷」后缀；章标与卷标渲染模式相互独立（各自持久化）。
 * 字体用 font-display 衬线体区分右侧正文文本；渲染模式仅存浏览器（zustand persist / localStorage），
 * 是大纲次序的衍生展示，不入服务器。
 * variant：act 卷标题头用加粗+更大字号，node 章节点用常规规格。
 */
const OrderTag: React.FC<{ index: number; suffix: '章' | '卷'; variant?: 'act' | 'node' }> = ({
  index,
  suffix,
  variant = 'node',
}) => {
  // 卷标与章标模式独立：act 读/循环 actNumMode，node 读/循环 outlineNumMode
  const mode = useUIStore((s) => (variant === 'act' ? s.actNumMode : s.outlineNumMode));
  const cycle = useUIStore((s) => (variant === 'act' ? s.cycleActNumMode : s.cycleOutlineNumMode));
  // 兼容：旧持久化残留的 'hidden' 视作 blank
  const m: 'cn' | 'num' | 'blank' = (mode as string) === 'hidden' ? 'blank' : mode;
  const tone =
    suffix === '章'
      ? 'bg-brand-500/12 text-brand-300 border border-brand-500/25'
      : 'bg-violet-500/12 text-violet-300 border border-violet-500/25';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        cycle();
      }}
      title={`顺序标签（绑定大纲次序，点击切换渲染：第${suffix === '卷' ? '一卷' : '一章'} / 1 / 无文字节点标；卷标与章标独立切换）`}
      aria-label={`第${index}${suffix}`}
      className={`shrink-0 rounded-md transition-colors ${
        m === 'blank'
          ? `${variant === 'act' ? 'w-3 h-3' : 'w-2.5 h-2.5'} ${tone} flex items-center justify-center`
          : `font-display px-1.5 py-0.5 tabular-nums leading-none ${
              variant === 'act' ? 'text-[11px] font-bold' : 'text-[10px] font-semibold'
            } ${tone}`
      }`}
    >
      {m === 'blank' ? null : m === 'cn' ? `第${toChineseNumeral(index)}${suffix}` : String(index)}
    </button>
  );
};

/** 结构化创作面板：大纲（幕 → 章节要点）→ AI 扩写 → 成稿章节。
 *  要点编辑器为中央标签页（OutlineNodeEditor），不再使用弹窗。 */
const OutlinePanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const { createChapter, selectChapter, fetchChapters, deleteChapter } = useNovelStore();

  const acts = useOutlineStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] ?? EMPTY_ACTS : EMPTY_ACTS,
  );
  const {
    loadOutline,
    addAct,
    updateAct,
    removeAct,
    addNode,
    addNodeAt,
    updateNode,
    removeNode,
  } = useOutlineStore();

  const { showToast } = useToast();

  const [collapsedActs, setCollapsedActs] = useState<Set<string>>(new Set());
  const [expandedOpen, setExpandedOpen] = useState(false);

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

  /** 省略号菜单「上/下方添加」：幕内按位置插入并打开编辑器 */
  const handleAddNodeAt = (actId: string, index: number) => {
    if (!novelId) return;
    const node = addNodeAt(novelId, actId, index);
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

  /** 省略号菜单「章节正文AIGC」：有绑定章节 → 打开正文并派发成章管线；
   *  无绑定 → 打开要点编辑器（写好梗概后用「扩写成稿」建章） */
  const handleBodyAIGC = async (actId: string, node: OutlineNode) => {
    const linked = node.chapter_id ? chapters.find((c) => c.id === node.chapter_id) : undefined;
    if (linked) {
      await selectChapter(linked);
      window.dispatchEvent(new CustomEvent('inkbloom:ai-compose'));
      showToast('已派发章节正文 AIGC（成章结果经预览确认后覆盖）', 'info');
      return;
    }
    openNodeEditor(actId, node);
  };

  /** 省略号菜单「导出章节」：节点信息（标题/幕/状态/梗概）+ 正文 → 下载 .md */
  const handleExportNode = (actTitle: string, node: OutlineNode) => {
    const chapter = node.chapter_id ? chapters.find((c) => c.id === node.chapter_id) : undefined;
    const statusText =
      node.status === 'published' ? '已发布' : node.status === 'done' ? '已完成' : '写作中';
    const content = [
      `# ${node.title || '未命名章节'}`,
      '',
      `- 所属幕：${actTitle || '未命名幕'}`,
      `- 状态：${statusText}`,
      node.chapter_id ? `- 章节 ID：${node.chapter_id}` : undefined,
      '',
      '## 梗概',
      htmlToPlainText(node.summary) || '（无）',
      '',
      '## 正文',
      chapter?.content ? htmlToPlainText(chapter.content) : '（尚未成稿）',
      '',
    ]
      .filter((l) => l !== undefined)
      .join('\n');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${node.title || '未命名章节'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('章节已导出（节点信息 + 正文）', 'success');
  };

  /** 省略号菜单「删除章节」：要点 + 绑定章节直接删除（无回收站，确认后执行） */
  const handleDeleteNode = async (actId: string, node: OutlineNode) => {
    if (!novelId) return;
    const ok = await confirmDialog({
      title: '删除章节',
      message: node.chapter_id
        ? `要点「${node.title || '未命名章节'}」及其正文将被永久删除，无法恢复，确定？`
        : `删除要点「${node.title || '未命名章节'}」？`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      if (node.chapter_id) await deleteChapter(node.chapter_id);
      removeNode(novelId, actId, node.id);
      showToast('已删除', 'info');
    } catch {
      showToast('删除失败，请检查后端连接', 'error');
    } finally {
      await loadOutline(novelId);
      await fetchChapters(novelId);
    }
  };

  /** 删除幕：幕下全部要点与绑定章节直接删除（无回收站，删除前确认），再移除空幕 */
  const handleRemoveAct = async (act: OutlineAct) => {
    if (!novelId) return;
    const boundCount = act.nodes.filter((n) => n.chapter_id).length;
    if (act.nodes.length > 0) {
      const ok = await confirmDialog({
        title: '删除幕',
        message: `「${act.title || '未命名幕'}」下 ${act.nodes.length} 个要点${
          boundCount ? `（含 ${boundCount} 章正文）` : ''
        }将被永久删除，无法恢复，确定？`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
    }
    let failed = false;
    for (const n of act.nodes) {
      try {
        if (n.chapter_id) await deleteChapter(n.chapter_id);
      } catch {
        failed = true;
        break;
      }
    }
    if (!failed) {
      // 空幕从本地移除并 PUT（loadOutline 已同步到服务端最新 version）
      removeAct(novelId, act.id);
      showToast('幕及要点已删除', 'info');
    } else {
      showToast('部分章节删除失败', 'error');
    }
    await loadOutline(novelId);
    await fetchChapters(novelId);
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

  // 幕序号与节点全局序号起点（顺序标签绑定大纲次序，跨幕连续计数）
  const actStarts = useMemo(() => {
    const map = new Map<string, { actNo: number; nodeStart: number }>();
    let actNo = 0;
    let nodeAcc = 0;
    for (const a of acts) {
      actNo += 1;
      map.set(a.id, { actNo, nodeStart: nodeAcc });
      nodeAcc += a.nodes.length;
    }
    return map;
  }, [acts]);

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
              从「第一卷」开始规划你的故事结构
            </p>
            <button
              onClick={handleAddAct}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 transition-all shadow-lg shadow-brand-600/20"
            >
              <Plus size={13} />
              创建第一卷
            </button>
          </div>
        )}

        {acts.map((act) => (
          <ActBlock
            key={act.id}
            act={act}
            actNo={actStarts.get(act.id)?.actNo ?? 1}
            nodeStart={actStarts.get(act.id)?.nodeStart ?? 0}
            collapsed={collapsedActs.has(act.id)}
            publishedIds={publishedChapterIds}
            onToggle={() => toggleAct(act.id)}
            onRename={() => {
              setEditingAct(act);
              setActTitleDraft(act.title);
            }}
            onRemove={() => handleRemoveAct(act)}
            onAddNode={() => handleAddNode(act.id)}
            onAddNodeAt={handleAddNodeAt}
            onEditNode={(node) => openNodeEditor(act.id, node)}
            onOpenBody={(node) => handleOpenBody(act.id, node)}
            onBodyAIGC={(node) => handleBodyAIGC(act.id, node)}
            onExportNode={(node) => handleExportNode(act.title, node)}
            onDeleteNode={(node) => handleDeleteNode(act.id, node)}
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
            placeholder="卷标题（如：第一卷 · 雨夜来信）"
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
    </div>
  );
};

// ── 幕区块 ──────────────────────────────────────────────────────────────
interface ActBlockProps {
  act: OutlineAct;
  /** 幕序号（顺序标签，大纲次序） */
  actNo: number;
  /** 本幕首个节点的全局序号起点（顺序标签跨幕连续计数） */
  nodeStart: number;
  collapsed: boolean;
  /** 发布状态的系统事实：已发布章节 id 集（published_chapters 表） */
  publishedIds: Set<number>;
  onToggle: () => void;
  onRename: () => void;
  onRemove: () => void;
  onAddNode: () => void;
  onAddNodeAt: (actId: string, index: number) => void;
  onEditNode: (node: OutlineNode) => void;
  onOpenBody: (node: OutlineNode) => void;
  onBodyAIGC: (node: OutlineNode) => void;
  onExportNode: (node: OutlineNode) => void;
  onDeleteNode: (node: OutlineNode) => void;
}

const ActBlock: React.FC<ActBlockProps> = ({
  act,
  actNo,
  nodeStart,
  collapsed,
  publishedIds,
  onToggle,
  onRename,
  onRemove,
  onAddNode,
  onAddNodeAt,
  onEditNode,
  onOpenBody,
  onBodyAIGC,
  onExportNode,
  onDeleteNode,
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
          {/* 幕顺序标签（绑定大纲次序，点击循环 第一章/X/隐藏；加粗+大字号变体） */}
          <OrderTag index={actNo} suffix="卷" variant="act" />
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
          {act.nodes.map((node, idx) => (
            <NodeCard
              key={node.id}
              node={node}
              orderIndex={nodeStart + idx + 1}
              nodeIdx={idx}
              actId={act.id}
              publishedIds={publishedIds}
              onEdit={() => onEditNode(node)}
              onOpenBody={() => onOpenBody(node)}
              onAddAt={onAddNodeAt}
              onEditNode={onEditNode}
              onBodyAIGC={onBodyAIGC}
              onExportNode={onExportNode}
              onDeleteNode={onDeleteNode}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── 章节要点卡片（点击打开中央要点编辑 tab；发布标 = 纯标识；省略号 = 操作菜单） ──
interface NodeCardProps {
  node: OutlineNode;
  /** 全局大纲次序（跨幕连续，顺序标签数据源） */
  orderIndex: number;
  /** 幕内下标（上/下方添加用） */
  nodeIdx: number;
  actId: string;
  publishedIds: Set<number>;
  onEdit: () => void;
  onOpenBody: () => void;
  onAddAt: (actId: string, index: number) => void;
  onEditNode: (node: OutlineNode) => void;
  onBodyAIGC: (node: OutlineNode) => void;
  onExportNode: (node: OutlineNode) => void;
  onDeleteNode: (node: OutlineNode) => void;
}

const NodeCard: React.FC<NodeCardProps> = ({
  node,
  orderIndex,
  nodeIdx,
  actId,
  publishedIds,
  onEdit,
  onOpenBody,
  onAddAt,
  onEditNode,
  onBodyAIGC,
  onExportNode,
  onDeleteNode,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // 菜单尺寸估算（w-44 + 8 项内容），用于视口翻转与左边界钳制
  const MENU_W = 176;
  const MENU_H = 300;

  /** 打开菜单：按按钮位置计算 fixed 坐标（portal 顶层渲染，规避滚动容器裁剪） */
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      let top = r.bottom + 4;
      if (top + MENU_H > window.innerHeight) top = Math.max(8, r.top - MENU_H - 4);
      let left = r.right - MENU_W;
      if (left < 8) left = 8;
      setMenuPos({ top, left });
    }
    setMenuOpen(true);
  };

  const closeMenu = () => setMenuOpen(false);
  // 已发布 = 系统事实（published_chapters 表），与写作/完成态解耦（备忘录 L61）
  const isPublished = node.chapter_id != null && publishedIds.has(node.chapter_id);
  // 写作状态圆点恒为两态展示（写作中/已完成）
  const writingStatus: OutlineStatus = node.status === 'published' ? 'done' : node.status;

  const menuItems: {
    label: string;
    danger?: boolean;
    action: () => void;
  }[] = [
    { label: '在上方添加', action: () => onAddAt(actId, nodeIdx) },
    { label: '在下方添加', action: () => onAddAt(actId, nodeIdx + 1) },
    { label: '─', action: () => {} },
    {
      label: '章节简述AIGC',
      action: () => onEditNode(node),
    },
    { label: '章节正文AIGC', action: () => onBodyAIGC(node) },
    { label: '─', action: () => {} },
    { label: '导出章节（信息+正文）', action: () => onExportNode(node) },
    { label: '删除章节', danger: true, action: () => onDeleteNode(node) },
  ];

  return (
    <div
      onClick={onEdit}
      className="group relative px-3 py-2 rounded-lg bg-surface-2 border border-white/6 hover:border-brand-500/30 cursor-pointer transition-all"
    >
      <div className="flex items-center gap-1.5">
        {/* 章节顺序标签（绑定大纲次序，点击循环 第一章/1/隐藏） */}
        <OrderTag index={orderIndex} suffix="章" />
        <span className="flex-1 min-w-0 text-xs text-neutral-200 truncate">
          {node.title || '未命名章节'}
        </span>
        {/* 发布标识：纯展示（备忘录 L61），不触发任何操作；
            发布操作在概览页发布管理，版本对比/回滚在章节版本历史面板 */}
        <span
          title={isPublished ? '已发布' : '未发布（在概览页发布管理中发布）'}
          className={`shrink-0 flex items-center justify-center w-5 h-5 rounded ${
            isPublished ? 'text-sky-300' : 'text-neutral-700'
          }`}
        >
          <Send size={11} />
        </span>
        {/* 省略号操作菜单（发布标右侧）：上下添加 / AIGC 工具 / 导出 / 删除。
            菜单 portal 到 body + fixed 定位（顶层渲染），修复被滚动容器/相邻面板遮住的 bug */}
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            ref={btnRef}
            type="button"
            onClick={() => (menuOpen ? closeMenu() : openMenu())}
            title="更多操作"
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
              menuOpen
                ? 'text-brand-300 bg-brand-500/15'
                : 'text-neutral-500 hover:text-neutral-200 hover:bg-white/8'
            }`}
          >
            <MoreHorizontal size={13} />
          </button>
          {menuOpen &&
            createPortal(
              <>
                {/* 点击外部关闭 */}
                <div className="fixed inset-0 z-[1040]" onClick={closeMenu} />
                <div
                  className="fixed w-44 rounded-lg border border-white/10 bg-surface-1 shadow-2xl py-1 animate-fade-in z-[1041]"
                  style={{ top: menuPos?.top ?? 0, left: menuPos?.left ?? 0 }}
                >
                  {menuItems.map((item, i) =>
                    item.label === '─' ? (
                      <div key={`sep-${i}`} className="my-1 border-t border-white/6" />
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          closeMenu();
                          item.action();
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                          item.danger
                            ? 'text-red-400 hover:bg-red-500/10'
                            : 'text-neutral-300 hover:bg-white/8 hover:text-neutral-100'
                        }`}
                      >
                        {item.label}
                      </button>
                    ),
                  )}
                </div>
              </>,
              document.body,
            )}
        </div>
      </div>
      {/* 正文入口（章名下方常驻，大纲与章节的交互合并——有正文就打开，没正文就建一章再打开） */}
      <div className="mt-1.5 pl-3.5 flex items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenBody();
          }}
          title={node.chapter_id ? '打开正文章节' : '创建并打开正文章节'}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-brand-500/12 text-brand-200 border border-brand-500/25 hover:bg-brand-500/25 hover:text-white transition-colors"
        >
          <FileText size={11} />
          {node.chapter_id ? '正文' : '写正文'}
          {/* 写作状态点（右靠）：绿=已完成 黄=写作中 */}
          <span
            className={`shrink-0 w-1.5 h-1.5 rounded-full ${STATUS_DOT[writingStatus] ?? STATUS_DOT.drafting}`}
          />
        </button>
      </div>
      {/* 节点简介不再预览在大纲面板节点元素（备忘录 L61）；梗概在要点编辑器内查看 */}
    </div>
  );
};

export default OutlinePanel;
