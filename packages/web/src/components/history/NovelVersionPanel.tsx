import React, { useCallback, useEffect, useState } from 'react';
import {
    BookMarked,
    Loader2,
    RotateCcw,
    Save,
    GitCommitHorizontal,
    AlertTriangle,
    ShieldCheck,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useNovelVersionStore } from '@/stores/novel-version-store';
import { useNovelStore } from '@/stores/novel-store';
import { useOutlineStore } from '@/stores/outline-store';
import { useMemoryStore } from '@/stores/memory-store';
import { useTabStore, chapterTabKey, countDraftWords } from '@/stores/tab-store';
import { useUIStore } from '@/stores/ui-store';
import { fetchChapterContent } from '@/services/history-client';
import type { RestoreMode } from '@/services/novel-version-client';
import { toast } from '@/components/common/Toast';

/**
 * 整本里程碑快照（Agent safety work Q3）
 *
 * 入口：编辑器工具栏「整本版本」按钮 → ui-store.novelVersionOpen。
 * 对象：当前选中的作品（novel-store.currentNovel），与章节版本历史互补。
 */

function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `今天 ${hhmm}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

const NovelVersionPanel: React.FC = () => {
    const open = useUIStore((s) => s.novelVersionOpen);
    const setOpen = useUIStore((s) => s.setNovelVersionOpen);
    const currentNovel = useNovelStore((s) => s.currentNovel);

    const { versions, total, loading, restoring, snapshotting, error, load, restore, snapshot, reset } =
        useNovelVersionStore();

    const [label, setLabel] = useState('');
    const [confirmId, setConfirmId] = useState<number | null>(null);
    const [mode, setMode] = useState<RestoreMode>('conservative');

    useEffect(() => {
        if (open && currentNovel?.id != null) {
            void load(currentNovel.id);
        }
        if (!open) {
            setConfirmId(null);
            setMode('conservative');
            reset();
        }
    }, [open, currentNovel?.id, load, reset]);

    /** 还原后整本刷新：章节列表（会 prune 失效 tab）、作品、大纲、记忆、仍打开的 tab 草稿 */
    const refreshWholeNovel = useCallback(
        async (novelId: number) => {
            const fetchNovels = useNovelStore.getState().fetchNovels;
            const fetchChapters = useNovelStore.getState().fetchChapters;
            void fetchNovels();
            await fetchChapters(novelId);
            void useOutlineStore.getState().loadOutline(novelId);
            void useMemoryStore.getState().loadMemory(novelId);

            // 刷新仍打开的章节 tab 草稿到还原后的正文
            const validIds = new Set(
                (useNovelStore.getState().chapters ?? []).map((c) => c.id),
            );
            for (const t of useTabStore.getState().tabs) {
                if (!validIds.has(t.chapterId)) continue;
                try {
                    const content = await fetchChapterContent(t.chapterId);
                    useTabStore.getState().updateTab(chapterTabKey(t.chapterId), {
                        draft: content,
                        wordCount: countDraftWords(content),
                        isDirty: false,
                        saveStatus: 'saved',
                    });
                } catch {
                    // 单个章节刷新失败不阻断整体结果
                }
            }
        },
        [],
    );

    const handleSnapshot = useCallback(async () => {
        if (currentNovel?.id == null) return;
        const id = await snapshot(currentNovel.id, label.trim() || undefined);
        if (id !== null) {
            setLabel('');
            toast.show('已存整本里程碑', 'success');
        }
    }, [currentNovel?.id, snapshot, label]);

    const handleRestore = useCallback(async () => {
        if (currentNovel?.id == null || confirmId === null) return;
        const ok = await restore(currentNovel.id, confirmId, mode);
        setConfirmId(null);
        if (!ok) return;
        await refreshWholeNovel(currentNovel.id);
        toast.show(mode === 'full' ? '已完整还原整本' : '已保守还原整本', 'success');
    }, [currentNovel?.id, confirmId, mode, restore, refreshWholeNovel]);

    const confirmTarget = versions.find((v) => v.id === confirmId) ?? null;
    const novelId = currentNovel?.id ?? null;

    return (
        <Modal
            open={open}
            onClose={() => setOpen(false)}
            title={
                <div className="flex items-center gap-2">
                    <BookMarked className="w-4 h-4 text-brand-300" />
                    <span>整本版本</span>
                    {currentNovel && (
                        <span className="text-xs text-neutral-500 font-normal truncate max-w-[220px]">
                            《{currentNovel.title}》
                        </span>
                    )}
                    {total > 0 && <span className="text-xs text-neutral-500 font-normal">共 {total} 个</span>}
                </div>
            }
            width="560px"
        >
            <div className="px-4 pb-4">
                {/* 存里程碑 */}
                <div className="flex items-center gap-2 mb-3">
                    <input
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="里程碑名称（可选，如「第一版定稿」）"
                        className="flex-1 px-2.5 py-1.5 text-xs rounded-md bg-white/5 border border-white/8 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
                    />
                    <button
                        type="button"
                        onClick={() => void handleSnapshot()}
                        disabled={snapshotting || novelId === null}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    >
                        {snapshotting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        存里程碑
                    </button>
                </div>

                {error && (
                    <div className="mb-3 flex items-center gap-2 px-2.5 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-300">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        {error}
                    </div>
                )}

                {novelId === null && (
                    <div className="py-8 text-center text-xs text-neutral-500">请先选择一部作品</div>
                )}

                {novelId !== null && loading && versions.length === 0 && (
                    <div className="py-8 flex justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
                    </div>
                )}

                {novelId !== null && !loading && versions.length === 0 && (
                    <div className="py-8 text-center text-xs text-neutral-500">
                        还没有整本里程碑。点「存里程碑」把整本书（正文 + 大纲 + 记忆）打包存一个可一键还原的快照。
                    </div>
                )}

                {/* 版本时间线 */}
                <div className="space-y-1 max-h-[46vh] overflow-y-auto pr-1">
                    {versions.map((v) => {
                        const isMilestone = v.kind === 'milestone';
                        return (
                            <div
                                key={v.id}
                                className="group flex items-start gap-2.5 px-2.5 py-2 rounded-lg hover:bg-white/4 transition-colors"
                            >
                                <div
                                    className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${isMilestone ? 'bg-brand-500' : 'bg-amber-500'
                                        }`}
                                />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`text-xs font-medium ${isMilestone ? 'text-brand-300' : 'text-amber-300'
                                                }`}
                                        >
                                            {isMilestone ? '手动里程碑' : '还原前'}
                                        </span>
                                        {v.label && <span className="text-xs text-neutral-300 truncate">{v.label}</span>}
                                    </div>
                                    <div className="text-[11px] text-neutral-500 mt-0.5">
                                        {isMilestone ? (
                                            <GitCommitHorizontal className="inline w-3 h-3 mr-0.5 -mt-0.5" />
                                        ) : null}
                                        {formatTime(v.created_at)} · {v.chapter_count} 章 · {v.word_count} 字
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMode('conservative');
                                            setConfirmId(v.id);
                                        }}
                                        disabled={restoring}
                                        title="一键还原整本"
                                        className="px-2 py-1 text-[11px] rounded text-neutral-400 hover:bg-amber-500/15 hover:text-amber-300 disabled:opacity-40 transition-colors"
                                    >
                                        还原
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 还原二次确认 + 模式选择 */}
            {confirmTarget && novelId !== null && (
                <div className="border-t border-white/8 px-4 py-3 bg-amber-500/5">
                    <div className="flex items-start gap-2 text-xs text-amber-200">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <div className="flex-1">
                            还原整本到
                            <span className="font-medium mx-1">{formatTime(confirmTarget.created_at)}</span>
                            的里程碑？还原前会自动存一个检查点，可再次还原撤销。
                        </div>
                    </div>
                    <div className="mt-2.5 space-y-1.5">
                        <label className="flex items-start gap-2 px-2.5 py-2 rounded-md bg-white/4 border border-white/8 cursor-pointer">
                            <input
                                type="radio"
                                name="restore-mode"
                                checked={mode === 'conservative'}
                                onChange={() => setMode('conservative')}
                                className="mt-0.5"
                            />
                            <span className="flex-1">
                                <span className="flex items-center gap-1 text-xs font-medium text-neutral-200">
                                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                                    保守还原（推荐）
                                </span>
                                <span className="block text-[11px] text-neutral-500 mt-0.5">
                                    只更新仍存在的章节，不重建已删章节、不删除之后新增的章节。
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2 px-2.5 py-2 rounded-md bg-white/4 border border-white/8 cursor-pointer">
                            <input
                                type="radio"
                                name="restore-mode"
                                checked={mode === 'full'}
                                onChange={() => setMode('full')}
                                className="mt-0.5"
                            />
                            <span className="flex-1">
                                <span className="text-xs font-medium text-neutral-200">完整还原</span>
                                <span className="block text-[11px] text-neutral-500 mt-0.5">
                                    还会重建快照中缺失的章节，并删除快照之外后来新增的章节。
                                </span>
                            </span>
                        </label>
                    </div>
                    <div className="flex justify-end gap-2 mt-2.5">
                        <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            className="px-2.5 py-1 text-xs rounded text-neutral-400 hover:bg-white/8 transition-colors"
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            disabled={restoring}
                            onClick={() => void handleRestore()}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-amber-600/25 text-amber-200 hover:bg-amber-600/35 disabled:opacity-50 transition-colors"
                        >
                            {restoring && <Loader2 className="w-3 h-3 animate-spin" />}
                            <RotateCcw className="w-3 h-3" />
                            确认还原
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
};

export default NovelVersionPanel;