import React, { useEffect, useState } from 'react';
import { BookOpen, Library, Maximize2, Plus, PenLine } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore } from '@/stores/ui-store';
import type { Novel } from '@/types';
import Modal from '@/components/common/Modal';
import LibraryExpandedView from './LibraryExpandedView';
import { useToast } from '@/components/common/Toast';

/**
 * 作品集成标签条（左侧板选项上方，备忘录 L61 作品库迁移）：
 *
 *  · 首列 = 「+ 新建作品」按钮（与作品标签同规格的第一个列元素）+ 作品库
 *    折叠开关；点击开关向下展开作品库列表（原作品库窗口规格：图标行 +
 *    字数，可滑动），再点收起。
 *  · 右侧 = 作品项标签（保留作品标签样式、取消字数显示），横向滑动，
 *    点击跳转该作品概览页，激活项高亮。
 *  · 「新建作品」弹窗与展开大视图（LibraryExpandedView）自原 NovelList 迁入。
 */
const WorksBar: React.FC = () => {
  const { novels, currentNovel, loading, fetchNovels, createNovel, selectNovel, deselectNovel } =
    useNovelStore();
  const { showToast } = useToast();
  const [libOpen, setLibOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedOpen, setExpandedOpen] = useState(false);

  useEffect(() => {
    fetchNovels();
  }, [fetchNovels]);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const novel = await createNovel({ title });
      setNewTitle('');
      setShowCreate(false);
      showToast(`作品「${title}」创建成功`, 'success');
      if (novel?.id) await selectNovel(novel);
      // 切换书本后回到该书的简介页（缺陷4：同步切换到其他书本的简介页）
      useUIStore.getState().setCenterTab('overview');
    } catch {
      showToast('创建失败，请重试', 'error');
    } finally {
      setCreating(false);
    }
  };

  // 新建小说页 → 调取全本创作窗口：清空当前选定，进入「需填书名」模式
  const openStoryWorkflow = () => {
    const t = newTitle.trim();
    if (!t || creating) return;
    setShowCreate(false);
    setNewTitle('');
    deselectNovel();
    const ui = useUIStore.getState();
    if (ui.rightCollapsed) ui.setRightWidth(ui.rightWidth || 320);
    window.dispatchEvent(new Event('inkbloom:open-story-workflow'));
  };

  const selectAndGoOverview = (novel: Novel) => {
    selectNovel(novel);
    useUIStore.getState().setCenterTab('overview');
  };

  const chipBase =
    'flex items-center gap-1 h-7 px-2.5 rounded-lg text-xs font-medium border shrink-0 transition-all';

  return (
    <div className="shrink-0 flex flex-col border-b border-white/6 bg-surface-1/60">
      {/* 标签条：首列（+ / 作品库开关）+ 右侧作品项标签 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {/* 首列：+ 新建（与作品标签同规格的首个列元素） */}
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          title="新建作品"
          className={`${chipBase} justify-center w-9 bg-gradient-to-r from-indigo-600/25 to-purple-600/25 text-indigo-200 border-indigo-500/30 hover:from-indigo-500/35 hover:to-purple-500/35`}
        >
          <Plus size={14} />
        </button>
        {/* 作品库折叠开关（库在左，点击下展） */}
        <button
          type="button"
          onClick={() => setLibOpen((v) => !v)}
          title={libOpen ? '收起作品库' : '展开作品库（原窗口规格，可滑动）'}
          className={`${chipBase} ${
            libOpen
              ? 'bg-brand-600/20 text-brand-300 border-brand-500/40'
              : 'bg-white/4 text-neutral-400 border-white/10 hover:bg-white/10 hover:text-neutral-200'
          }`}
        >
          <Library size={13} />
          作品库
        </button>

        <div className="w-px h-4 bg-white/10 shrink-0" />

        {/* 作品项标签（右）：保留标签样式，取消字数显示，点击跳概览页 */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
          {novels.map((novel) => {
            const active = currentNovel?.id === novel.id;
            return (
              <button
                key={novel.id}
                type="button"
                onClick={() => selectAndGoOverview(novel)}
                title={novel.title}
                className={`${chipBase} max-w-[140px] ${
                  active
                    ? 'bg-gradient-to-r from-brand-600/25 to-fuchsia-600/15 text-neutral-100 border-brand-500/40 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                    : 'bg-white/4 text-neutral-400 border-white/10 hover:bg-white/10 hover:text-neutral-200'
                }`}
              >
                <BookOpen size={12} className={active ? 'text-brand-300' : 'text-neutral-500'} />
                <span className="truncate">{novel.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 作品库下展列表：原作品库窗口规格（图标 + 标题 + 字数），可滑动 */}
      {libOpen && (
        <div className="border-t border-white/6 max-h-[38vh] overflow-y-auto py-1 animate-fade-in">
          {loading && (
            <div className="space-y-2 px-3 py-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-3 py-2.5 rounded-lg bg-white/3">
                  <div className="skeleton h-3.5 w-3/4 mb-2" />
                  <div className="skeleton h-2.5 w-1/3" />
                </div>
              ))}
            </div>
          )}
          {!loading && novels.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mx-3 my-1 px-3 py-4 rounded-lg border border-dashed border-white/10 text-neutral-500 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/5 transition-colors flex flex-col items-center gap-1.5 w-[calc(100%-1.5rem)]"
            >
              <PenLine size={16} />
              <span className="text-xs">创建你的第一部作品</span>
            </button>
          )}
          {novels.map((novel) => {
            const active = currentNovel?.id === novel.id;
            return (
              <div
                key={novel.id}
                onClick={() => {
                  selectAndGoOverview(novel);
                  setLibOpen(false);
                }}
                className={`group relative flex items-center gap-2.5 mx-2 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
                  active
                    ? 'bg-gradient-to-r from-brand-600/20 to-brand-600/5 text-neutral-100'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-gradient-to-b from-indigo-400 to-pink-400" />
                )}
                <span
                  className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${
                    active ? 'bg-brand-500/20 text-brand-300' : 'bg-white/5 text-neutral-500'
                  }`}
                >
                  <BookOpen size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">{novel.title}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5">
                    {novel.word_count ? `${novel.word_count.toLocaleString()} 字` : '尚未开始'}
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && novels.length > 0 && (
            <div className="px-3 pt-1 pb-1.5">
              <button
                type="button"
                onClick={() => setExpandedOpen(true)}
                className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-brand-300 transition-colors"
              >
                <Maximize2 size={12} />
                展开大视图
              </button>
            </div>
          )}
        </div>
      )}

      {/* 新建对话框（自 NovelList 迁入） */}
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setNewTitle('');
        }}
        title="新建作品"
      >
        <div className="px-5 py-4">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="输入作品标题…"
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg bg-white/5 text-sm text-neutral-100 border border-white/10 placeholder-neutral-500 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewTitle('');
              }}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!newTitle.trim() || creating}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              {creating ? '创建中…' : '创建'}
            </button>
            <button
              type="button"
              onClick={openStoryWorkflow}
              disabled={!newTitle.trim() || creating}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-violet-600/20"
            >
              创建并开启全本创作
            </button>
          </div>
        </div>
      </Modal>

      {/* 作品库展开大视图：点击卡片选中作品并关闭大视图 */}
      <LibraryExpandedView
        open={expandedOpen}
        onClose={() => setExpandedOpen(false)}
        novels={novels}
        currentNovelId={currentNovel?.id}
        onSelect={(novel) => {
          setExpandedOpen(false);
          selectAndGoOverview(novel);
        }}
      />
    </div>
  );
};

export default WorksBar;
