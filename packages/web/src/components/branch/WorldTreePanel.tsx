import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Plus,
  Trash2,
  GitBranch,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  Network,
} from 'lucide-react';
import { useBranchStore, type BranchNode } from '@/stores/branch-store';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';
import { confirmDialog } from '@/components/common/ConfirmDialog';

/** 树节点视图模型：节点 + 子分支 */
interface BranchVM {
  node: BranchNode;
  children: BranchVM[];
}

/** 平铺节点组为树；孤儿节点（父缺失）挂到根层，避免不可达 */
const buildTree = (list: BranchNode[]): BranchVM[] => {
  const byId = new Map<number, BranchVM>();
  const roots: BranchVM[] = [];
  for (const n of list) byId.set(n.id, { node: n, children: [] });
  for (const vm of byId.values()) {
    const p = vm.node.parent_id;
    const parent = p ? byId.get(p) : undefined;
    if (parent) parent.children.push(vm);
    else roots.push(vm);
  }
  return roots;
};

const sourceBadge = (n: BranchNode) =>
  n.source === 'ai' ? (
    <span
      title="AI 生成"
      className="shrink-0 flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-fuchsia-500/12 text-fuchsia-300 border border-fuchsia-500/20"
    >
      <Sparkles size={9} /> AI
    </span>
  ) : null;

interface WorldTreePanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 世界线面板（全书分支图节点树）：VSCode 终端式底部面板。
 * 节点 = 剧情分歧点（标题 + 章节概述）；大部分由 AI 生成（Agent 工具
 * save_branch），点击绑定章节可跳转；支持手工添加子分支与删除子树。
 */
const WorldTreePanel: React.FC<WorldTreePanelProps> = ({ open, onClose }) => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const novelId = currentNovel?.id;
  const nodes = useBranchStore((s) => (novelId ? s.byNovel[novelId] : undefined));
  const loading = useBranchStore((s) => s.loading);
  const load = useBranchStore((s) => s.load);
  const create = useBranchStore((s) => s.create);
  const remove = useBranchStore((s) => s.remove);
  const { showToast } = useToast();

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [addingParent, setAddingParent] = useState<number | 'root' | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && novelId) void load(novelId);
  }, [open, novelId, load]);

  const tree = useMemo(() => buildTree(nodes ?? []), [nodes]);

  if (!open || !currentNovel || !novelId) return null;

  const startAdd = (parent: number | 'root') => {
    setAddingParent(parent);
    setTitleDraft('');
    setSummaryDraft('');
  };

  const submitAdd = async () => {
    if (!titleDraft.trim() || !summaryDraft.trim() || submitting) return;
    setSubmitting(true);
    try {
      await create(novelId, {
        parent_id: addingParent === 'root' ? 0 : addingParent ?? 0,
        title: titleDraft.trim(),
        summary: summaryDraft.trim(),
        source: 'user',
      });
      showToast('分支已添加', 'success');
      setAddingParent(null);
    } catch {
      showToast('添加失败，请检查后端服务', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  /** AI 生成分支：跳转 AI 对话并预填指令（Agent 经 save_branch 工具落库） */
  const aiGenerate = (parent?: number) => {
    const parentHint =
      parent != null
        ? `在世界线分支节点 #${parent} 下`
        : '在世界线主线根部';
    window.dispatchEvent(new CustomEvent('inkbloom:show-chat'));
    window.dispatchEvent(
      new CustomEvent('inkbloom:chat-draft', {
        detail: {
          text: `请先用 list_branches 查看现有分支，然后用 save_branch 工具为《${currentNovel.title}》${parentHint}生成 2-3 个剧情分支：每个分支给出有张力的分歧标题（title）和 2-4 句的章节概述（summary）。`,
        },
      }),
    );
    onClose();
  };

  const jumpToChapter = (chapterId: number) => {
    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) {
      showToast('绑定的章节不存在（可能已删除）', 'error');
      return;
    }
    void useNovelStore.getState().selectChapter(chapter);
    onClose();
  };

  /** 递归渲染分支节点 */
  const renderNode = (vm: BranchVM, depth: number) => {
    const n = vm.node;
    const isCollapsed = collapsed.has(n.id);
    const boundChapter = n.chapter_id ? chapters.find((c) => c.id === n.chapter_id) : undefined;
    return (
      <div key={n.id} className={depth > 0 ? 'ml-3 pl-3 border-l border-white/10' : ''}>
        <div className="group flex items-start gap-2 rounded-lg bg-white/3 border border-white/6 hover:border-brand-500/30 px-2.5 py-2 transition-colors">
          <button
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(n.id)) next.delete(n.id);
                else next.add(n.id);
                return next;
              })
            }
            className={`shrink-0 p-0.5 text-neutral-500 hover:text-neutral-300 transition-colors ${vm.children.length === 0 ? 'invisible' : ''}`}
            title={isCollapsed ? '展开子分支' : '收起子分支'}
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <GitBranch size={12} className="shrink-0 mt-0.5 text-sky-300/80" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-neutral-200 truncate">{n.title}</span>
              {sourceBadge(n)}
              {boundChapter && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    jumpToChapter(n.chapter_id!);
                  }}
                  title="跳转到对应章节"
                  className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/12 text-brand-300 border border-brand-500/20 hover:bg-brand-500/25 transition-colors"
                >
                  {boundChapter.title || '未命名章节'}
                </button>
              )}
            </div>
            {n.summary && (
              <p className="mt-0.5 text-[11px] text-neutral-500 leading-relaxed line-clamp-2">
                {n.summary}
              </p>
            )}
          </div>
          {/* 悬浮操作 */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={() => startAdd(n.id)}
              title="在此分支下添加子分支"
              className="p-1 rounded text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
            >
              <Plus size={11} />
            </button>
            <button
              onClick={() => aiGenerate(n.id)}
              title="让 AI 在此分支下生成分支（打开 AI 对话）"
              className="p-1 rounded text-neutral-500 hover:text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors"
            >
              <Sparkles size={11} />
            </button>
            <button
              onClick={async () => {
                const ok = await confirmDialog({
                  title: '删除分支',
                  message:
                    vm.children.length > 0
                      ? `删除「${n.title}」及其全部子分支？该操作不可撤销。`
                      : `删除「${n.title}」？该操作不可撤销。`,
                  confirmText: '删除',
                  danger: true,
                });
                if (ok) {
                  void remove(novelId, n.id, vm.children.length > 0).then(() =>
                    showToast('分支已删除', 'info'),
                  );
                }
              }}
              title="删除分支"
              className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
        {/* 子分支 */}
        {!isCollapsed && vm.children.map((child) => renderNode(child, depth + 1))}
        {/* 内联添加表单 */}
        {addingParent === n.id && renderAddForm()}
      </div>
    );
  };

  const renderAddForm = () => (
    <div className="my-1.5 rounded-lg border border-brand-500/30 bg-brand-500/5 p-2.5 flex flex-col gap-2 animate-fade-in">
      <input
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        placeholder="分支标题，如：若主角没有接下那封信"
        autoFocus
        className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50"
      />
      <textarea
        value={summaryDraft}
        onChange={(e) => setSummaryDraft(e.target.value)}
        rows={2}
        placeholder="章节概述：这个分支里发生什么、走向如何（2-4 句）"
        className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 resize-none"
      />
      <div className="flex justify-end gap-1.5">
        <button
          onClick={() => setAddingParent(null)}
          className="px-2.5 py-1 rounded-md text-[11px] text-neutral-400 hover:bg-white/8 transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => void submitAdd()}
          disabled={!titleDraft.trim() || !summaryDraft.trim() || submitting}
          className="px-3 py-1 rounded-md text-[11px] font-medium bg-gradient-to-r from-brand-600 to-fuchsia-600 text-white disabled:opacity-40 transition-all"
        >
          {submitting ? '保存中…' : '添加分支'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 h-[46vh] min-h-[320px] bg-surface-1 border-t border-white/10 shadow-[0_-8px_40px_rgba(0,0,0,0.5)] flex flex-col animate-fade-in">
      {/* 面板头（VSCode 终端式标题条） */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/6 bg-surface-1/80">
        <Network size={13} className="text-sky-300" />
        <span className="text-xs font-semibold text-neutral-200">世界线 · 全书分支</span>
        <span className="text-[10px] text-neutral-600">{nodes?.length ?? 0} 个节点</span>
        <div className="flex-1" />
        <button
          onClick={() => aiGenerate(undefined)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors"
          title="让 AI 生成主线分支（打开 AI 对话）"
        >
          <Sparkles size={11} /> AI 生成分支
        </button>
        <button
          onClick={() => startAdd('root')}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-neutral-300 hover:bg-white/8 transition-colors"
          title="在主线根部添加分支"
        >
          <Plus size={11} /> 添加分支
        </button>
        <button
          onClick={onClose}
          title="关闭世界线面板"
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* 树内容 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={16} className="animate-spin text-brand-400" />
          </div>
        ) : tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10">
            <GitBranch size={22} className="text-neutral-700 mb-2" />
            <p className="text-xs text-neutral-500 leading-relaxed">
              还没有世界线分支。
              <br />
              <span className="text-neutral-600">
                点击「AI 生成分支」让 AI 规划剧情分歧，或手工添加第一个分支
              </span>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-w-4xl mx-auto">
            {tree.map((vm) => renderNode(vm, 0))}
            {addingParent === 'root' && renderAddForm()}
          </div>
        )}
      </div>
    </div>
  );
};

export default WorldTreePanel;
