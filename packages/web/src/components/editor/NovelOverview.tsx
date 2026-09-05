import React, { useEffect, useState } from 'react';
import { BookOpen, Trash2, FileText, Wand2, Clock, PenLine, Send, BarChart3, Network, History } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useOutlineStore } from '@/stores/outline-store';
import { useTabStore } from '@/stores/tab-store';
import { useUIStore } from '@/stores/ui-store';
import { usePublishStore } from '@/stores/publish-store';
import { useToast } from '@/components/common/Toast';
import PublishModal from '@/components/publish/PublishModal';
import WorkStatsPanel from '@/components/publish/WorkStatsPanel';
import WorldTreePanel from '@/components/branch/WorldTreePanel';

/**
 * 作品概览页（简介页）：选中作品后中央编辑区显示（无打开章节时）。
 * 作品元信息 + 发布入口（发布操作与读者数据看板的唯一入口）+ 世界线入口 + 删除入口。
 * 发布按钮从编辑器工具栏迁移至此；读者数据看板从发布弹窗分离至此。
 */
const NovelOverview: React.FC = () => {
    const { currentNovel, chapters, deleteNovel } = useNovelStore();
    const { showToast } = useToast();
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [publishOpen, setPublishOpen] = useState(false);
    const [worldTreeOpen, setWorldTreeOpen] = useState(false);

    // 发布状态（系统事实）：概览页承担发布入口与读者看板，挂载即拉取
    const pubWork = usePublishStore((s) =>
        currentNovel ? s.byNovel[currentNovel.id]?.work ?? null : null,
    );
    const pubChapterCount = usePublishStore(
        (s) => (currentNovel ? s.byNovel[currentNovel.id]?.chapters.length ?? 0 : 0),
    );

    // 切换书本时取消删除确认态
    useEffect(() => {
        setDeleteConfirm(false);
        setPublishOpen(false);
        setWorldTreeOpen(false);
        if (currentNovel) void usePublishStore.getState().load(currentNovel.id);
    }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!currentNovel) return null;

    const chapterCount = chapters.length;

    const handleDelete = async () => {
        if (deleting) return;
        setDeleting(true);
        try {
            await deleteNovel(currentNovel.id);
            showToast('作品已删除', 'info');
        } catch {
            showToast('删除失败，请重试', 'error');
        } finally {
            setDeleting(false);
            setDeleteConfirm(false);
        }
    };

    const handleNewChapter = async () => {
        // 文章库并入大纲：新建章节 = 在最新幕的末尾追加要点，并立即打开该要点的
        // 中央编辑标签页（要点编辑器承载标题/梗概/写正文/成章）。
        const ost = useOutlineStore.getState();
        let acts = ost.byNovel[currentNovel.id];
        if (!acts) {
            await ost.loadOutline(currentNovel.id);
            acts = useOutlineStore.getState().byNovel[currentNovel.id] ?? [];
        }
        let act = acts[acts.length - 1];
        if (!act) act = ost.addAct(currentNovel.id, '');
        const node = useOutlineStore.getState().addNode(currentNovel.id, act.id);
        useTabStore.getState().openPanelTab(
            `outline-node-${node.id}`,
            node.title || '未命名章节',
            'outline-node',
            { actId: act.id, nodeId: node.id, novelId: currentNovel.id },
        );
        showToast(`已在「${act.title || '未命名幕'}」新建章节要点，填写梗概后可直接成章`, 'success');
    };

    return (
        <div className="flex-1 overflow-y-auto bg-surface-0 relative">
            {/* 背景光晕 */}
            <div className="absolute top-1/4 left-1/3 w-80 h-80 rounded-full bg-indigo-600/10 blur-[110px] pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

            <div className="relative w-full max-w-2xl px-8 py-10 mx-auto animate-fade-in">
                {/* 标题区 */}
                <div className="flex items-start gap-4 mb-6">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/25 to-pink-500/25 border border-white/10 flex items-center justify-center shrink-0">
                        <BookOpen size={28} className="text-brand-300" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-2xl font-semibold text-neutral-100 truncate">{currentNovel.title}</h1>
                        <div className="flex items-center gap-3 mt-2 text-xs text-neutral-500 flex-wrap">
                            {currentNovel.genre && (
                                <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-neutral-400">
                                    {currentNovel.genre}
                                </span>
                            )}
                            <span className="flex items-center gap-1">
                                <FileText size={12} /> {chapterCount} 章
                            </span>
                            {currentNovel.word_count ? (
                                <span className="flex items-center gap-1">
                                    <PenLine size={12} /> {currentNovel.word_count.toLocaleString()} 字
                                </span>
                            ) : null}
                            <span className="flex items-center gap-1">
                                <Clock size={12} />
                                {new Date(currentNovel.created_at).toLocaleDateString()}
                            </span>
                        </div>
                    </div>
                </div>

                {/* 简介：只读展示 */}
                <div className="rounded-xl bg-white/4 border border-white/8 p-4 mb-6">
                    <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap">
                        {currentNovel.description?.trim()
                            ? currentNovel.description
                            : '暂无简介。点击「AI 起稿」由 AI 生成，或在中央起稿窗口编辑。'}
                    </p>
                </div>

                {/* 操作区：发布入口从编辑器工具栏迁移至此；世界线管理全书分支 */}
                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={handleNewChapter}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm font-medium transition-all shadow-lg shadow-indigo-600/20"
                    >
                        <PenLine size={14} /> 新建章节
                    </button>
                    <button
                        onClick={() => window.dispatchEvent(new CustomEvent('inkbloom:open-story-workflow'))}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 text-violet-300 text-sm font-medium transition-all"
                    >
                        <Wand2 size={14} /> AI 起稿
                    </button>
                    <div className="flex-1" />
                    <button
                        onClick={() => useUIStore.getState().setNovelVersionOpen(true)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600/15 hover:bg-amber-600/25 text-amber-300 text-sm font-medium transition-all"
                        title="整本里程碑快照：创建/还原全书版本（为后续世界线导出做准备）"
                    >
                        <History size={14} /> 全本版本
                    </button>
                    <button
                        onClick={() => setWorldTreeOpen(true)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600/15 hover:bg-sky-600/25 text-sky-300 text-sm font-medium transition-all"
                        title="打开世界线：全书分支图节点树（AI 深度参与的剧情分歧管理）"
                    >
                        <Network size={14} /> 世界线
                    </button>
                    <button
                        onClick={() => setPublishOpen(true)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 text-sm font-medium transition-all"
                        title="发布到 InkBloom 公开阅读（发布操作与取消发布统一在弹窗内）"
                    >
                        <Send size={14} />
                        {pubWork ? `发布管理（${pubChapterCount} 章已发布）` : '发布'}
                    </button>
                </div>

                {/* 读者数据看板：从发布弹窗分离至此，仅作品已发布后展示 */}
                {pubWork && (
                    <div className="mt-8">
                        <div className="flex items-center gap-1.5 mb-3">
                            <BarChart3 size={13} className="text-emerald-300" />
                            <span className="text-xs font-semibold text-neutral-200">读者数据</span>
                            <span className="text-[10px] text-neutral-600">
                                追更 / 阅读 / 每章漏斗与情绪曲线
                            </span>
                        </div>
                        <div className="rounded-xl bg-white/4 border border-white/8 p-3">
                            <WorkStatsPanel workId={pubWork.id} />
                        </div>
                    </div>
                )}

                {/* 删除入口（概览页底部） */}
                <div className="mt-10 pt-6 border-t border-white/6 flex justify-end">
                    {deleteConfirm ? (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-red-400">确认删除该作品？此操作不可撤销</span>
                            <button
                                onClick={handleDelete}
                                disabled={deleting}
                                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
                            >
                                {deleting ? '删除中…' : '确认删除'}
                            </button>
                            <button
                                onClick={() => setDeleteConfirm(false)}
                                className="px-3 py-1.5 rounded-lg bg-white/8 text-neutral-300 hover:bg-white/15 text-xs transition-colors"
                            >
                                取消
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setDeleteConfirm(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-neutral-500 hover:text-red-400 hover:bg-red-500/10 text-xs transition-colors"
                        >
                            <Trash2 size={13} /> 删除作品
                        </button>
                    )}
                </div>
            </div>

            {/* 发布弹窗（Portal 到 body，与工具栏时期一致） */}
            <PublishModal open={publishOpen} onClose={() => setPublishOpen(false)} />

            {/* 世界线面板：VSCode 终端式底部面板（全书分支图节点树） */}
            <WorldTreePanel open={worldTreeOpen} onClose={() => setWorldTreeOpen(false)} />
        </div>
    );
};

export default NovelOverview;
