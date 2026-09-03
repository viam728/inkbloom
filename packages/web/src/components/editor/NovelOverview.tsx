import React, { useEffect, useState } from 'react';
import { BookOpen, Trash2, FileText, Wand2, Clock, PenLine } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';

/**
 * 作品概览页（简介页）：选中作品后中央编辑区显示（无打开章节时）。
 * 仅用于展示作品元信息 + 删除入口；编辑/AI 填写统一走中央「AI 起稿」窗口。
 */
const NovelOverview: React.FC = () => {
    const { currentNovel, chapters, deleteNovel } = useNovelStore();
    const { showToast } = useToast();
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // 切换书本时取消删除确认态
    useEffect(() => {
        setDeleteConfirm(false);
    }, [currentNovel?.id]);

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
        // 文章库并入大纲：章节正文统一在大纲面板管理（要点上的「写正文」入口）
        showToast('请在大纲面板选择要点，点「写正文」创建章节', 'info');
    };

    return (
        <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
            {/* 背景光晕 */}
            <div className="absolute top-1/4 left-1/3 w-80 h-80 rounded-full bg-indigo-600/10 blur-[110px] pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

            <div className="relative w-full max-w-2xl px-8 animate-fade-in">
                {/* 标题区 */}
                <div className="flex items-start gap-4 mb-6">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/25 to-pink-500/25 border border-white/10 flex items-center justify-center shrink-0">
                        <BookOpen size={28} className="text-brand-300" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-2xl font-semibold text-neutral-100 truncate">{currentNovel.title}</h1>
                        <div className="flex items-center gap-3 mt-2 text-xs text-neutral-500">
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

                {/* 操作区 */}
                <div className="flex items-center gap-2">
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
                </div>

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
        </div>
    );
};

export default NovelOverview;
