import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Sparkles, FileText } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useMemoryStore, sortMemoryItems } from '@/stores/memory-store';
import {
  useOutlineStore,
  OUTLINE_STATUS_LABELS,
  WRITABLE_OUTLINE_STATUSES,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { usePublishStore } from '@/stores/publish-store';
import { useTabStore, chapterTabKey } from '@/stores/tab-store';
import { useEditorStore } from '@/stores/editor-store';
import { saveOutline } from '@/services/outline-client';
import { agentGenerate } from '@/services/agent-client';
import { trashNode } from '@/services/trash-client';
import { resolveSceneModel } from '@/stores/ai-store';
import { useToast } from '@/components/common/Toast';
import TipTapEditor from '@/components/editor/TipTapEditor';
import DraftPreviewModal from './DraftPreviewModal';

/** 旧纯文本 summary 迁移为编辑器 HTML（幂等：已是 HTML 则原样返回） */
const toEditorHtml = (raw: string): string => {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('<') && raw.includes('>')) return raw;
  return raw
    .split('\n')
    .map((line) => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return escaped.trim() ? `<p>${escaped}</p>` : '<p></p>';
    })
    .join('');
};

const STATUS_CHIP: Record<OutlineStatus, string> = {
  drafting: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
  done: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  published: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
};

interface OutlineNodeEditorProps {
  tabKey: string;
  actId: string;
  nodeId: string;
}

/**
 * 章节要点编辑器（中央标签页）：原 OutlinePanel 编辑弹窗的内容整体迁入，
 * 数据经 outline-store 实时读写；发布中的节点状态只读（发布状态由系统管理）。
 */
const OutlineNodeEditor: React.FC<OutlineNodeEditorProps> = ({ tabKey, actId, nodeId }) => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const { createChapter, selectChapter, fetchChapters } = useNovelStore();
  const acts = useOutlineStore((s) => (currentNovel ? s.byNovel[currentNovel.id] : undefined));
  const { updateNode, moveNode } = useOutlineStore();
  const { showToast } = useToast();

  const novelId = currentNovel?.id;
  const outlineLoaded = useOutlineStore((s) => (currentNovel ? !!s.byNovel[currentNovel.id] : false));

  // 发布状态系统事实
  const pubChapters = usePublishStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id]?.chapters : undefined,
  );
  const publishedChapterIds = useMemo(
    () => new Set((pubChapters ?? []).map((c) => c.chapter_id)),
    [pubChapters],
  );

  const act = acts?.find((a) => a.id === actId);
  const node = act?.nodes.find((n) => n.id === nodeId) ?? null;
  const nodeIdx = act?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  const nodeCount = act?.nodes.length ?? 0;

  // 要点已被删除（或作品切换后不复存在）：自动关闭本 tab
  useEffect(() => {
    if (outlineLoaded && !node) useTabStore.getState().closeTab(tabKey);
  }, [outlineLoaded, node, tabKey]);

  // 打开/换节点时初始化草稿（面板常驻挂载，节点变化才重置）
  const [titleDraft, setTitleDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [editorFocused, setEditorFocused] = useState(false);
  useEffect(() => {
    if (node) {
      setTitleDraft(node.title);
      setSummaryDraft(toEditorHtml(node.summary));
      setEditorFocused(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, actId]);

  const commitNodeEdit = (patch?: Partial<OutlineNode>) => {
    if (!novelId || !node) return;
    updateNode(novelId, actId, node.id, {
      title: titleDraft.trim(),
      summary: summaryDraft.trim(),
      ...patch,
    });
  };

  // ── 大纲 → 成稿：AI 扩写（自 OutlinePanel 迁入） ─────────────────────
  const [expandTarget, setExpandTarget] = useState<OutlineNode | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftRefs, setDraftRefs] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);

  const handleExpand = async () => {
    if (!novelId || !node) return;
    commitNodeEdit();
    setExpandTarget({ ...node, title: titleDraft.trim(), summary: summaryDraft.trim() });
    setDraft(null);
    setDraftRefs([]);

    let refs: string[] = [];
    try {
      const mem = useMemoryStore.getState();
      if (!mem.byNovel[novelId]) await mem.loadMemory(novelId);
      const items = useMemoryStore.getState().byNovel[novelId] ?? [];
      const allActs = useOutlineStore.getState().byNovel[novelId] ?? [];
      const statusById = new Map(allActs.flatMap((a) => a.nodes.map((n) => [n.id, n.status] as const)));
      refs = sortMemoryItems(items)
        .filter(
          (i) =>
            i.ai_visible !== false &&
            (!i.visible_chapters?.length ||
              i.visible_chapters.some((id) => {
                const st = statusById.get(id);
                return st === 'done' || st === 'published';
              })),
        )
        .map((i) => i.name)
        .slice(0, 6);
    } catch {
      /* 无设定也可扩写 */
    }

    try {
      // 备忘录 L61 修复：扩写走带完整上下文（大纲结构 / 前文 / 记忆 / 伏笔）的
      // Agent 生成管线（scene=chapter），而非无上下文的轻量端点；失败如实报错，
      // 不再静默回退本地 mock 模板（此前用户拿到的「AI 初稿」其实是假草稿）。
      // 先落盘大纲，确保 Agent 从 DB 读到最新节点概要。
      const latestActs = useOutlineStore.getState().byNovel[novelId];
      if (latestActs) await saveOutline(novelId, latestActs).catch(() => {});
      const res = await agentGenerate({
        novel_id: novelId,
        scene: 'chapter',
        node_id: nodeId,
        instruction:
          '请基于该要点的标题与梗概、它在大纲中的位置、前文与既有设定，撰写本章完整正文。',
        model: resolveSceneModel('expand'),
      });
      setDraftRefs(refs);
      setDraft(res.content);
    } catch (e) {
      showToast(`扩写失败：${e instanceof Error ? e.message : '请重试'}`, 'error');
      setExpandTarget(null);
    }
  };

  /** 按大纲顺序计算新章节的插入位置（自 OutlinePanel 迁入） */
  const computeInsertAt = (): number => {
    if (!acts) return 0;
    let count = 0;
    for (const a of acts) {
      for (const n of a.nodes) {
        if (a.id === actId && n.id === nodeId) return count;
        if (n.chapter_id && chapters.some((c) => c.id === n.chapter_id)) count++;
      }
    }
    return count;
  };

  const handleWriteDraft = async () => {
    if (!novelId || !expandTarget || !draft) return;
    setWriting(true);
    try {
      const title = expandTarget.title || '未命名章节';
      // 备忘录 L57/59：一个要点唯一绑定一个章节。已有有效绑定时，扩写覆盖其
      // 编辑版本正文，绝不重复建章（此前无条件 createChapter 造成同名重复章节）。
      const linked = node?.chapter_id ? chapters.find((c) => c.id === node.chapter_id) : undefined;
      if (linked) {
        await useEditorStore.getState().saveChapter(linked.id, draft);
        updateNode(novelId, actId, nodeId, { status: 'drafting', memory_refs: draftRefs });
        useNovelStore.setState({ currentChapter: { ...linked, content: draft } });
        const tab = useTabStore.getState().tabs.find((t) => t.key === chapterTabKey(linked.id));
        if (tab) useTabStore.getState().updateTab(tab.key, { draft, isDirty: false, saveStatus: 'saved' });
        showToast(`初稿已覆盖更新章节「${title}」`, 'success');
      } else {
        const insertAt = computeInsertAt();
        const chapter = await createChapter({ novel_id: novelId, title, content: draft }, insertAt);
        updateNode(novelId, actId, nodeId, {
          chapter_id: chapter.id,
          status: 'drafting',
          memory_refs: draftRefs,
        });
        useNovelStore.setState({ currentChapter: { ...chapter, content: draft } });
        showToast(`初稿已写入章节「${title}」（第 ${insertAt + 1} 章）`, 'success');
      }
      setExpandTarget(null);
      setDraft(null);
    } catch {
      showToast('后端未连接，无法保存章节，可先复制初稿', 'error');
    } finally {
      setWriting(false);
    }
  };

  /** 正文入口：有绑定章节直接打开；没有就建一章再打开 */
  const handleOpenBody = async () => {
    if (!novelId || !node) return;
    commitNodeEdit();
    const linked = node.chapter_id ? chapters.find((c) => c.id === node.chapter_id) : undefined;
    if (linked) {
      await selectChapter(linked);
      return;
    }
    const title = node.title?.trim() || '未命名章节';
    try {
      const insertAt = computeInsertAt();
      const chapter = await createChapter({ novel_id: novelId, title, content: '' }, insertAt);
      updateNode(novelId, actId, nodeId, {
        chapter_id: chapter.id,
        status:
          node.status === 'done' || node.status === 'published'
            ? node.status
            : 'drafting',
      });
      await selectChapter(chapter);
      showToast(`已为「${title}」创建正文，可直接开写`, 'success');
    } catch {
      showToast('创建正文章节失败，请检查后端连接', 'error');
    }
  };

  /** 删除要点（垃圾桶）：节点 + 绑定章节一起移入回收站，成功后关闭本 tab */
  const handleRemoveNode = async () => {
    if (!novelId || !node) return;
    if (
      node.chapter_id &&
      !window.confirm(`要点「${node.title || '未命名章节'}」连同其正文将移入回收站，可随时恢复，确定？`)
    ) {
      return;
    }
    try {
      await trashNode(novelId, actId, node.id);
      showToast('已移入回收站', 'info');
    } catch {
      showToast('删除失败，请检查后端连接', 'error');
    } finally {
      await useOutlineStore.getState().loadOutline(novelId);
      await fetchChapters(novelId);
    }
    useTabStore.getState().closeTab(tabKey);
  };

  if (!node) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
        要点不存在或已删除
      </div>
    );
  }

  const isPublished =
    node.status === 'published' || (node.chapter_id != null && publishedChapterIds.has(node.chapter_id));

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto px-8 py-4">
      <div className="flex flex-col gap-3 max-w-3xl w-full mx-auto min-h-0 flex-1">
        {/* 标题 */}
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          placeholder="章节标题（将用于成稿章节名）"
          className="w-full px-3 py-2 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
        />

        {/* 剧情要点编辑器 */}
        <div
          className={`${editorFocused ? 'h-[70vh]' : 'flex-1 min-h-[260px]'} rounded-lg border border-white/10 bg-white/4 overflow-hidden flex flex-col`}
        >
          <TipTapEditor
            content={summaryDraft}
            onChange={setSummaryDraft}
            variant="memo"
            toolbarPreset="plain"
            placeholder={'剧情要点：主角在雨夜发现密信，与旧友摊牌……'}
            editorClassName="prose prose-invert prose-sm max-w-none min-h-[120px] px-3 py-2 text-neutral-200 focus:outline-none"
            focusable
            focused={editorFocused}
            onToggleFocus={() => setEditorFocused((v) => !v)}
          />
        </div>

        {/* 状态：写作两态切换；已发布由系统管理只读 */}
        {!editorFocused && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-neutral-500 mr-1">状态</span>
            {isPublished ? (
              <span
                className={`text-[11px] px-2.5 py-1 rounded-full border ${STATUS_CHIP.published}`}
                title="发布状态由系统管理"
              >
                {OUTLINE_STATUS_LABELS.published}
              </span>
            ) : (
              WRITABLE_OUTLINE_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => commitNodeEdit({ status: s })}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                    node.status === s
                      ? STATUS_CHIP[s]
                      : 'bg-white/4 text-neutral-500 border-white/8 hover:text-neutral-300'
                  }`}
                >
                  {OUTLINE_STATUS_LABELS[s]}
                </button>
              ))
            )}
            <div className="flex-1" />
            <span className="text-[10px] text-neutral-600">
              {(nodeIdx >= 0 ? nodeIdx + 1 : '-')}/{nodeCount}
            </span>
          </div>
        )}

        {/* 操作行 */}
        {!editorFocused && (
          <div className="flex items-center gap-1.5 pb-2">
            <button
              onClick={() => void handleExpand()}
              disabled={!summaryDraft.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:opacity-40 transition-all shadow-lg shadow-brand-600/20"
            >
              <Sparkles size={12} />
              扩写成稿
            </button>
            <button
              onClick={() => void handleOpenBody()}
              title={node.chapter_id ? '打开正文章节' : '创建并打开正文章节'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand-100 bg-brand-500/15 border border-brand-500/30 hover:bg-brand-500/28 hover:text-white transition-all"
            >
              <FileText size={12} />
              {node.chapter_id ? '打开正文' : '写正文'}
            </button>
            <div className="flex-1" />
            <button
              onClick={() => novelId && moveNode(novelId, actId, nodeId, -1)}
              disabled={nodeIdx <= 0}
              title="在大纲中上移"
              className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
            >
              <ArrowUp size={13} />
            </button>
            <button
              onClick={() => novelId && moveNode(novelId, actId, nodeId, 1)}
              disabled={nodeIdx < 0 || nodeIdx >= nodeCount - 1}
              title="在大纲中下移"
              className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 disabled:opacity-30 transition-colors"
            >
              <ArrowDown size={13} />
            </button>
            <button
              onClick={() => void handleRemoveNode()}
              title="删除要点"
              className="p-1.5 rounded-md text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={13} />
            </button>
            <button
              onClick={() => commitNodeEdit()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              保存
            </button>
          </div>
        )}
      </div>

      {/* 扩写初稿预览 */}
      <DraftPreviewModal
        open={expandTarget !== null}
        title={expandTarget?.title || ''}
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

export default OutlineNodeEditor;
