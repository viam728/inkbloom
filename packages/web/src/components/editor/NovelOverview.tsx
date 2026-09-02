import React, { useEffect, useState } from 'react';
import { BookOpen, Trash2, FileText, PenLine, Wand2, Clock, Check, X, Pencil } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';

/**
 * 作品概览页（简介页）：选中作品后中央编辑区显示（无打开章节时）。
 * 默认只读展示作品元信息 + 删除入口；右上角「编辑」切换整页为编辑态，
 * 可手动修改每字段（书名 / 类型 / 简介）。简介的快速 AI 生成走中央
 * 「AI 起稿」窗口（派发 inkbloom:open-story-workflow）。
 */
const NovelOverview: React.FC = () => {
    const { currentNovel, chapters, deleteNovel, updateNovel } = useNovelStore();
    const { showToast } = useToast();
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // 编辑开关式交互：默认只读；点击「编辑」切换整页为编辑态
    const [editing, setEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editGenre, setEditGenre] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [saving, setSaving] = useState(false);

    // 切换书本时：同步预填各字段并退出编辑态（缺陷4：切换书本要切到新书的简介页）
    useEffect(() => {
        if (!currentNovel) return;
        setEditTitle(currentNovel.title ?? '');
        setEditGenre(currentNovel.genre ?? '');
        setEditDescription(currentNovel.description ?? '');
        setEditing(false);
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
        // 打开章节列表侧栏的创建入口（复用 ChapterList 的交互）
        // 这里只提示，实际创建走左侧 ChapterList 或命令面板
        showToast('请在左侧「章节」列表新建章节', 'info');
    };

    // 编辑态：保存各字段
    const handleSave = async () => {
        const t = editTitle.trim();
        if (!t) {
            showToast('书名不能为空', 'error');
            return;
        }
        if (saving) return;
        setSaving(true);
        try {
            const desc = editDescription.trim();
            const g = editGenre.trim();
            await updateNovel(currentNovel.id, {
                title: t,
                description: desc,
                // 空类型视为清空分类（后端按空串清空）
                genre: g,
            });
            setEditing(false);
            showToast('已保存', 'success');
        } catch {
            showToast('保存失败，请重试', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleCancelEdit = () => {
        setEditTitle(currentNovel.title ?? '');
        setEditGenre(currentNovel.genre ?? '');
        setEditDescription(currentNovel.description ?? '');
        setEditing(false);
    };

    return (
        <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
            {/* 背景光晕 */}
            <div className="absolute top-1/4 left-1/3 w-80 h-80 rounded-full bg-indigo-600/10 blur-[110px] pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-pink-600/8 blur-[100px] pointer-events-none" />

            <div className="relative w-full max-w-2xl px-8 animate-fade-in">
                {/* 标题区 + 编辑开关 */}
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div className="flex items-start gap-4 min-w-0 flex-1">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/25 to-pink-500/25 border border-white/10 flex items-center justify-center shrink-0">
                            <BookOpen size={28} className="text-brand-300" />
                        </div>
                        <div className="flex-1 min-w-0">
                            {editing ? (
                                <input
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="书名"
                                    className="w-full px-2 py-1.5 text-2xl font-semibold bg-white/5 border border-white/10 rounded-lg outline-none focus:border-violet-500/50 text-neutral-100 placeholder-neutral-500"
                                />
                            ) : (
                                <h1 className="text-2xl font-semibold text-neutral-100 truncate">{currentNovel.title}</h1>
                            )}
                            <div className="flex items-center gap-3 mt-2 text-xs text-neutral-500">
                                {editing ? (
                                    <input
                                        value={editGenre}
                                        onChange={(e) => setEditGenre(e.target.value)}
                                        placeholder="类型（如：玄幻 / 都市）"
                                        className="px-2 py-1 text-xs bg-white/5 border border-white/10 rounded-md outline-none focus:border-violet-500/50 text-neutral-300 placeholder-neutral-500"
                                    />
                                ) : (
                                    currentNovel.genre && (
                                        <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-neutral-400">
                                            {currentNovel.genre}
                                        </span>
                                    )
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

                    {/* 右上角编辑开关 */}
                    {editing ? (
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-xs font-medium transition-all disabled:opacity-50"
                            >
                                {saving ? <Clock size={13} className="animate-spin" /> : <Check size={13} />}
                                保存
                            </button>
                            <button
                                onClick={handleCancelEdit}
                                disabled={saving}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-neutral-300 text-xs transition-colors disabled:opacity-50"
                            >
                                <X size={13} /> 取消
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setEditing(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium border border-white/10 transition-colors shrink-0"
                        >
                            <Pencil size={13} /> 编辑
                        </button>
                    )}
                </div>

                {/* 简介：只读 / 编辑切换 */}
                <div className="rounded-xl bg-white/4 border border-white/8 p-4 mb-6">
                    {editing ? (
                        <textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            rows={5}
                            placeholder="作品简介（可选），帮助读者与 AI 更好地理解你的故事…"
                            className="w-full px-2.5 py-2 text-sm bg-white/5 border border-white/8 rounded-lg outline-none focus:border-violet-500/50 text-neutral-200 placeholder-neutral-500 resize-y leading-relaxed"
                        />
                    ) : (
                        <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap">
                            {currentNovel.description?.trim()
                                ? currentNovel.description
                                : '暂无简介。点击右上角「编辑」手动填写，或点「AI 起稿」由 AI 生成。'}
                        </p>
                    )}
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
