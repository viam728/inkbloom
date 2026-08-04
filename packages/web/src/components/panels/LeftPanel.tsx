import React from 'react';
import { Search, Sparkles, Library, Brain, ListOrdered, Megaphone, Lightbulb } from 'lucide-react';
import NovelList from './NovelList';
import ChapterList from './ChapterList';
import KnowledgePanel from '../knowledge/KnowledgePanel';
import MemoryPanel from '../memory/MemoryPanel';
import OutlinePanel from '../outline/OutlinePanel';
import MediaLibraryPanel from '../media/MediaLibraryPanel';
import TopicPoolPanel from '../media/TopicPoolPanel';
import RoleSwitcher from '../layout/RoleSwitcher';
import { useUIStore, type LeftTab, type CreatorRole } from '@/stores/ui-store';

/** 小说作者：作品库 / 大纲 / 记忆 */
const NOVELIST_TABS: { id: LeftTab; label: string; icon: React.ReactNode }[] = [
  { id: 'library', label: '作品库', icon: <Library size={13} /> },
  { id: 'outline', label: '大纲', icon: <ListOrdered size={13} /> },
  { id: 'memory', label: '记忆', icon: <Brain size={13} /> },
];

/** 自媒体作者：内容库 / 选题池 / 记忆 */
const MEDIA_TABS: { id: LeftTab; label: string; icon: React.ReactNode }[] = [
  { id: 'contents', label: '内容库', icon: <Megaphone size={13} /> },
  { id: 'topics', label: '选题池', icon: <Lightbulb size={13} /> },
  { id: 'memory', label: '记忆', icon: <Brain size={13} /> },
];

const TABS_BY_ROLE: Record<CreatorRole, typeof NOVELIST_TABS> = {
  novelist: NOVELIST_TABS,
  media: MEDIA_TABS,
  memo: NOVELIST_TABS, // memo 模式下左栏不可见，此处仅占位
};

const LeftPanel: React.FC = () => {
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const leftTab = useUIStore((s) => s.leftTab);
  const setLeftTab = useUIStore((s) => s.setLeftTab);
  const role = useUIStore((s) => s.role);

  const tabs = TABS_BY_ROLE[role] ?? NOVELIST_TABS;
  // 持久化的 leftTab 可能与当前角色不匹配，回退到第一个 Tab
  const activeTab = tabs.some((t) => t.id === leftTab) ? leftTab : tabs[0].id;

  return (
    <div className="w-full h-full flex flex-col bg-surface-1">
      {/* Logo + 标题 */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center text-[15px] shadow-lg shadow-indigo-500/20">
          🌸
        </div>
        <h1 className="text-[15px] font-bold bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
          InkBloom
        </h1>
        <span className="ml-auto flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/20">
          <Sparkles size={10} />
          AI
        </span>
      </div>

      {/* 创作场景切换 */}
      <div className="px-3 pb-1.5">
        <RoleSwitcher />
      </div>

      {/* 快速搜索入口 */}
      <div className="px-3 pb-2">
        <button
          onClick={() => setPaletteOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/4 border border-white/6 text-neutral-500 hover:text-neutral-300 hover:bg-white/7 hover:border-white/12 transition-colors text-xs"
        >
          <Search size={13} />
          <span className="flex-1 text-left">快速跳转…</span>
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-white/6 border border-white/8 text-neutral-500">
            Ctrl K
          </kbd>
        </button>
      </div>

      {/* Tab 切换：按角色展示不同 Tab */}
      <div className="flex gap-1 px-3 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setLeftTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-brand-600/20 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {activeTab === 'library' && (
        <>
          <div className="flex-1 overflow-y-auto py-1 min-h-0">
            <NovelList />
            <ChapterList />
          </div>
          {/* 知识图谱面板 */}
          <KnowledgePanel />
        </>
      )}
      {activeTab === 'outline' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <OutlinePanel />
        </div>
      )}
      {activeTab === 'memory' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MemoryPanel />
        </div>
      )}
      {activeTab === 'contents' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MediaLibraryPanel />
        </div>
      )}
      {activeTab === 'topics' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <TopicPoolPanel />
        </div>
      )}
    </div>
  );
};

export default LeftPanel;
