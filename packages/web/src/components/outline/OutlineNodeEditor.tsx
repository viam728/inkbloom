import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Sparkles, FileText } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useOutlineStore,
  OUTLINE_STATUS_LABELS,
  toggleWritingStatus,
  sortChaptersByOutline,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import { usePublishStore } from '@/stores/publish-store';
import { publishChapter, unpublishChapter } from '@/services/reader-client';
import { useTabStore, chapterTabKey } from '@/stores/tab-store';
import { useEditorStore } from '@/stores/editor-store';
import { useToast } from '@/components/common/Toast';
import { confirmDialog } from '@/components/common/ConfirmDialog';
import { useChapterDraft } from '@/hooks/useChapterDraft';
import { putAutoSnapshot } from '@/utils/temp-branch';
import TipTapEditor from '@/components/editor/TipTapEditor';
import AigcCard from '@/components/ai/AigcCard';
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

/** 写作状态点配色（黄=写作中 绿=已完成），与大纲列表/工具栏一致 */
const STATUS_DOT: Record<OutlineStatus, string> = {
  drafting: 'bg-amber-400',
  done: 'bg-emerald-400',
  published: 'bg-sky-400',
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
  const { createChapter, selectChapter, fetchChapters, deleteChapter } = useNovelStore();
  const acts = useOutlineStore((s) => (currentNovel ? s.byNovel[currentNovel.id] : undefined));
  const { updateNode, moveNode } = useOutlineStore();
  const { showToast } = useToast();

  const novelId = currentNovel?.id;
  const outlineLoaded = useOutlineStore((s) => (currentNovel ? !!s.byNovel[currentNovel.id] : false));

  const act = acts?.find((a) => a.id === actId);
  const node = act?.nodes.find((n) => n.id === nodeId) ?? null;
  const nodeIdx = act?.nodes.findIndex((n) => n.id === nodeId) ?? -1;
  const nodeCount = act?.nodes.length ?? 0;

  // 大纲尚未加载（如刷新后恢复 tab / 切换作品瞬间）：先拉取再判定，
  // 不能把「还没加载到」误判为「要点不存在或已删除」
  useEffect(() => {
    if (currentNovel && !outlineLoaded) {
      void useOutlineStore.getState().loadOutline(currentNovel.id);
    }
  }, [currentNovel?.id, outlineLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // 要点已被删除（大纲加载完成后的空命中）→ 自动关闭本 tab
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
    const nextTitle = titleDraft.trim();
    const titleChanged = !!nextTitle && nextTitle !== node.title;
    updateNode(novelId, actId, node.id, {
      title: nextTitle,
      summary: summaryDraft.trim(),
      ...patch,
    });
    // 标题双向同步（要点 ↔ 章节）：要点标题变更时同步绑定章节的标题，
    // 章节列表 / 中央 tab 标签 / currentChapter 由 renameChapter 联动刷新
    if (titleChanged && node.chapter_id != null) {
      void useNovelStore
        .getState()
        .renameChapter(node.chapter_id, nextTitle)
        .catch(() => undefined);
      const tk = chapterTabKey(node.chapter_id);
      if (useTabStore.getState().tabs.some((t) => t.key === tk)) {
        useTabStore.getState().renameTab(tk, nextTitle);
      }
    }
  };

  // ── 大纲 → 成稿：AI 扩写（自 OutlinePanel 迁入） ─────────────────────
  const [expandTarget, setExpandTarget] = useState<OutlineNode | null>(null);
  const [writing, setWriting] = useState(false);
  const { draft, memoryRefs: draftRefs, generate: generateChapter, reset } = useChapterDraft();

  const handleExpand = async () => {
    if (!novelId || !node) return;
    commitNodeEdit();
    setExpandTarget({ ...node, title: titleDraft.trim(), summary: summaryDraft.trim() });
    // 备忘录 L61：扩写走带完整上下文（大纲 / 前文 / 记忆 / 伏笔）的 Agent 成章
    // 管线（scene=chapter），失败如实报错，不再静默回退本地 mock 模板。
    await generateChapter(novelId, { nodeId });
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
        // AI 扩写覆盖已有章节正文前：先存入工作区自动快照（浏览器本地，可撤销）
        const prevTab = useTabStore.getState().tabs.find((t) => t.key === chapterTabKey(linked.id));
        const prev = prevTab?.draft ?? linked.content ?? '';
        if (prev.trim()) putAutoSnapshot(linked.id, prev, 'AI 扩写覆盖前');
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
      reset();
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

  /** 删除要点：节点 + 绑定章节直接删除（无回收站，删除前确认），成功后关闭本 tab */
  const handleRemoveNode = async () => {
    if (!novelId || !node) return;
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
      useOutlineStore.getState().removeNode(novelId, actId, node.id);
      showToast('已删除', 'info');
    } catch {
      showToast('删除失败，请检查后端连接', 'error');
    } finally {
      await useOutlineStore.getState().loadOutline(novelId);
      await fetchChapters(novelId);
    }
    useTabStore.getState().closeTab(tabKey);
  };

  // ── 发布 / 取消发布二合一控制（节点页右侧） ────────────────────────────
  // 发布态以 published_chapters 表为系统事实（publish-store 缓存）。
  // 规则：第 n 章可发布 ⟺ 大纲序 1..n-1 章已全部发布（从第1章起连续）；
  // 取消发布 ⟺ 其后没有已发布章节（只能从最后一章起依次取消）。
  const publishState = usePublishStore((s) => (novelId ? s.byNovel[novelId] : undefined));
  const publishedWork = publishState?.work ?? null;
  const pubByChapterId = useMemo(
    () => new Map((publishState?.chapters ?? []).map((c) => [c.chapter_id, c])),
    [publishState?.chapters],
  );
  const orderedChapters = useMemo(
    () => sortChaptersByOutline(chapters, acts),
    [chapters, acts],
  );
  const [publishing, setPublishing] = useState(false);

  // 打开节点页即拉取发布状态（系统事实）
  useEffect(() => {
    if (novelId) void usePublishStore.getState().load(novelId);
  }, [novelId]);

  const chapterIdx = node?.chapter_id != null ? orderedChapters.findIndex((c) => c.id === node.chapter_id) : -1;
  const isChapterPublished = node?.chapter_id != null && pubByChapterId.has(node.chapter_id);
  const allPrevPublished =
    chapterIdx >= 0 && orderedChapters.slice(0, chapterIdx).every((c) => pubByChapterId.has(c.id));
  const hasLaterPublished =
    chapterIdx >= 0 && orderedChapters.slice(chapterIdx + 1).some((c) => pubByChapterId.has(c.id));

  /** 发布控制按钮的禁用原因（可发布/可取消时返回 null） */
  const publishBlockReason = (): string | null => {
    if (!node?.chapter_id) return '该要点尚未绑定正文章节，请先创建正文';
    if (!publishedWork) return '请先在作品概览页「发布管理」中发布作品';
    if (!isChapterPublished && !allPrevPublished) return '发布须从第1章起连续，请先发布前面的章节';
    if (isChapterPublished && hasLaterPublished) return '后面的章节仍在发布中，需先从最后一章起依次取消发布';
    return null;
  };

  const handleTogglePublish = async () => {
    if (!novelId || !node) return;
    const blocked = publishBlockReason();
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }
    const ch = orderedChapters.find((c) => c.id === node.chapter_id);
    if (!ch) {
      showToast('未在大纲序中找到该章节', 'error');
      return;
    }
    if (!isChapterPublished) {
      const ok = await confirmDialog({
        title: '发布章节',
        message: `将向读者发布「${ch.title}」，确定发布？`,
      });
      if (!ok) return;
      setPublishing(true);
      try {
        const done = await publishChapter(publishedWork!.id, { chapter_id: ch.id });
        await usePublishStore.getState().markPublished(novelId, [done]);
        // 发布只写完成标记（写作态），与发布态解耦（备忘录 L61）
        commitNodeEdit({ status: 'done' });
        showToast('已发布，读者即刻可读', 'success');
      } catch (e) {
        showToast(e instanceof Error ? e.message : '发布失败', 'error');
      } finally {
        setPublishing(false);
      }
    } else {
      const ok = await confirmDialog({
        title: '取消发布',
        message: `取消发布后读者将立即无法阅读「${ch.title}」，确定取消发布？`,
        danger: true,
      });
      if (!ok) return;
      setPublishing(true);
      try {
        const pid = pubByChapterId.get(ch.id)!.id;
        await unpublishChapter(pid);
        await usePublishStore.getState().markUnpublished(novelId, ch.id);
        showToast('已取消发布该章', 'info');
      } catch (e) {
        showToast(e instanceof Error ? e.message : '取消发布失败', 'error');
      } finally {
        setPublishing(false);
      }
    }
  };

  if (!node) {
    // 大纲未加载 → 加载中态；加载完成仍无此要点 → 确实不存在/已删除
    if (!outlineLoaded) {
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
          正在加载要点…
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
        要点不存在或已删除
      </div>
    );
  }

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

        {/* 操作行（紧贴标题下方，备忘录 L61）：成稿 / 正文 / 状态标记 / 排序 / 删除 / 保存 */}
        <div className="flex items-center gap-1.5 pb-2 flex-wrap">
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
          {/* 写作状态二合一（备忘录 L61）：单按钮点击即切换 写作中 ↔ 已完成，
              无确认提示；发布态解耦，旧 published 态按已完成展示。 */}
          <span className="text-[11px] text-neutral-500 ml-1 mr-0.5">状态</span>
          <button
            type="button"
            onClick={() => commitNodeEdit({ status: toggleWritingStatus(node.status) })}
            title="点击切换写作状态（写作中 ↔ 已完成）"
            className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              STATUS_CHIP[node.status === 'published' ? 'done' : node.status]
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                STATUS_DOT[node.status === 'published' ? 'done' : node.status]
              }`}
            />
            {OUTLINE_STATUS_LABELS[node.status === 'published' ? 'done' : node.status]}
          </button>
          <div className="flex-1" />
          {/* 发布 / 取消发布二合一控制（节点页右侧）：带确认弹窗；
              可发布 ⟺ 前面章节已全部发布（从第1章起连续），取消 ⟺ 其后无已发布章节 */}
          <button
            type="button"
            onClick={() => void handleTogglePublish()}
            disabled={publishing}
            title={publishBlockReason() ?? (isChapterPublished ? '点击取消发布该章' : '点击发布该章给读者')}
            className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 ${
              isChapterPublished
                ? 'bg-sky-500/12 text-sky-300 border-sky-500/25 hover:bg-sky-500/25'
                : 'bg-white/4 text-neutral-500 border-white/8 hover:text-neutral-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isChapterPublished ? 'bg-sky-400' : 'bg-neutral-600'
              }`}
            />
            {isChapterPublished ? '已发布' : '未发布'}
          </button>
          <span className="text-[10px] text-neutral-600 tabular-nums">
            {(nodeIdx >= 0 ? nodeIdx + 1 : '-')}/{nodeCount}
          </span>
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
            aigcSlot={
              /* AIGC 配置卡（备忘录 L61）：基于标题与全书上下文生成/润色剧情要点，
                 产物直接覆盖梗概草稿（未保存前可继续编辑，点「保存」才落库） */
              <AigcCard
                novelId={novelId}
                scene="outline"
                nodeId={node.id}
                taskLabel="AIGC · 剧情要点"
                hint="按标题与大纲上下文生成或润色剧情要点"
                buildInstruction={(extra) =>
                  [
                    `要点标题：${titleDraft.trim() || '（未命名）'}`,
                    summaryDraft.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                      ? `现有梗概：${summaryDraft.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)}`
                      : '',
                    extra ? `附加要求：${extra}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                }
                onApply={(c) => setSummaryDraft(toEditorHtml(c))}
              />
            }
          />
        </div>
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
          reset();
        }}
        onWrite={handleWriteDraft}
      />
    </div>
  );
};

export default OutlineNodeEditor;
