import React, { useEffect, useState } from 'react';
import { BookOpen, Library, Maximize2, Plus, PenLine } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore } from '@/stores/ui-store';
import { useTabStore, overviewTabKey } from '@/stores/tab-store';
import type { Novel } from '@/types';
import LibraryExpandedView from './LibraryExpandedView';

/**
 * 作品集成标签条（左侧板选项上方，备忘录 L61 作品库迁移）：
 *
 *  · 作品库折叠开关在左（默认即品牌预设激活色，展开时更亮）；点击向下展开
 *    作品库列表（原作品库窗口规格：图标行 + 字数，可滑动），再点收起。
 *  · 下展列表首个列元素 = 「创建小说」按钮（与作品行同尺寸、同配色方案），
 *    点击直接在中央区域打开 AI 起稿页（小说尚未创建，书名与创建确认在
 *    起稿页底部完成）。
 *  · 右侧 = 仅显示当前作品项：作品库选中态同款样式（渐变底 + 左侧指示条 +
 *    品牌图标），随容器宽度缩放、文本按空间伸缩（truncate），无字数显示，
 *    点击跳转概览页（全书首页）。
 *  · 展开大视图（LibraryExpandedView）自原 NovelList 迁入。
 */
const WorksBar: React.FC = () => {
  const { novels, currentNovel, loading, fetchNovels, selectNovel, deselectNovel } =
    useNovelStore();
  const [libOpen, setLibOpen] = useState(false);
  const [expandedOpen, setExpandedOpen] = useState(false);

  useEffect(() => {
    fetchNovels();
  }, [fetchNovels]);

  // 创建小说 → 中央区域直接打开 AI 起稿页：清空当前选定（作品尚未创建），
  // 书名与创建确认由起稿页底部按钮承担
  const openStoryWorkflow = () => {
    deselectNovel();
    const ui = useUIStore.getState();
    if (ui.rightCollapsed) ui.setRightWidth(ui.rightWidth || 320);
    window.dispatchEvent(new Event('inkbloom:open-story-workflow'));
  };

  const selectAndGoOverview = (novel: Novel) => {
    selectNovel(novel);
    // 全书首页 = 可关闭的 Home tab（每部作品一个）；点击当前书即聚焦其首页
    useTabStore
      .getState()
      .openPanelTab(overviewTabKey(novel.id), novel.title, 'overview', { novelId: novel.id });
  };

  const chipBase =
    'flex items-center gap-1 h-7 px-2.5 rounded-lg text-xs font-medium border shrink-0 transition-all';

  return (
    <div className="relative shrink-0 flex flex-col border-b border-white/6 bg-surface-1/60">
      {/* 标签条：作品库开关（左）+ 当前作品项（右）；容器随面板宽度缩放 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {/* 作品库折叠开关：默认品牌预设激活色，展开时更亮 */}
        <button
          type="button"
          onClick={() => setLibOpen((v) => !v)}
          title={libOpen ? '收起作品库' : '展开作品库（原窗口规格，可滑动）'}
          className={`${chipBase} ${
            libOpen
              ? 'bg-brand-600/35 text-brand-200 border-brand-400/50 shadow-[0_0_10px_rgba(99,102,241,0.25)]'
              : 'bg-brand-600/15 text-brand-300 border-brand-500/30 hover:bg-brand-600/25'
          }`}
        >
          <Library size={13} />
          作品库
        </button>

        <div className="w-px h-4 bg-white/10 shrink-0" />

        {/* 作品项（右）：仅显示当前作品，作品库选中态同款样式（渐变底 + 左侧指示条），
            随容器缩放（flex-1 + truncate），无字数显示，点击跳转概览页（全书首页） */}
        {currentNovel ? (
          <button
            type="button"
            onClick={() => selectAndGoOverview(currentNovel)}
            title={currentNovel.title}
            className="relative flex items-center gap-2 h-7 flex-1 min-w-0 pl-3 pr-3 rounded-lg bg-gradient-to-r from-brand-600/20 to-brand-600/5 text-neutral-100 border border-brand-500/25 hover:from-brand-600/35 hover:border-brand-400/40 hover:text-white transition-all"
          >
            {/* 激活指示条（与作品库选中态一致） */}
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-gradient-to-b from-indigo-400 to-pink-400" />
            <span className="shrink-0 w-5 h-5 rounded-md flex items-center justify-center bg-brand-500/20 text-brand-300">
              <BookOpen size={12} />
            </span>
            <span className="text-xs font-medium truncate">{currentNovel.title}</span>
          </button>
        ) : (
          <span className="text-xs text-neutral-600 shrink-0">未选择作品</span>
        )}
      </div>

      {/* 作品库下展列表：**悬浮展开页**（absolute 浮于下方内容之上，不挤压布局），
          原作品库窗口规格（图标 + 标题 + 字数），可滑动 */}
      {libOpen && (
        <div className="absolute left-0 right-0 top-full z-30 max-h-[46vh] overflow-y-auto py-1 border border-t-0 border-white/10 rounded-b-lg bg-surface-1 shadow-2xl animate-fade-in">
          {/* 展开大视图入口：置于下展列表上方顶部、右置（px-3 pt-1 pb-1.5） */}
          {novels.length > 0 && (
            <div className="flex justify-end px-3 pt-1 pb-1.5">
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
          {/* 首个列元素：创建小说（与作品行同尺寸、同配色方案）；点击直接打开 AI 起稿页 */}
          <button
            type="button"
            onClick={openStoryWorkflow}
            title="创建小说：打开 AI 起稿页，填写书名后创建"
            className="w-full flex items-center gap-2.5 mx-0 px-3 py-2 rounded-lg text-neutral-400 hover:bg-white/8 hover:text-neutral-200 transition-all duration-150"
          >
            <span className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-white/5 text-neutral-500">
              <Plus size={14} />
            </span>
            <span className="flex-1 min-w-0 text-left text-[13px] font-medium">创建小说</span>
          </button>
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
              onClick={openStoryWorkflow}
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
        </div>
      )}

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
