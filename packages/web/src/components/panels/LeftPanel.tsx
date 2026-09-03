import React from 'react';
import { Library, Brain, ListOrdered, Megaphone, Lightbulb } from 'lucide-react';
import NovelList from './NovelList';
import KnowledgePanel from '../knowledge/KnowledgePanel';
import MemoryPanel from '../memory/MemoryPanel';
import OutlinePanel from '../outline/OutlinePanel';
import MediaLibraryPanel from '../media/MediaLibraryPanel';
import TopicPoolPanel from '../media/TopicPoolPanel';
import ErrorBoundary from '../common/ErrorBoundary';
import { useNovelStore } from '@/stores/novel-store';
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
  const leftTab = useUIStore((s) => s.leftTab);
  const setLeftTab = useUIStore((s) => s.setLeftTab);
  const role = useUIStore((s) => s.role);
  // 切换作品时重置大纲错误边界，避免上一部作品的崩溃态残留
  const currentNovelId = useNovelStore((s) => s.currentNovel?.id);

  const tabs = TABS_BY_ROLE[role] ?? NOVELIST_TABS;
  // 持久化的 leftTab 可能与当前角色不匹配，回退到第一个 Tab
  const activeTab = tabs.some((t) => t.id === leftTab) ? leftTab : tabs[0].id;

  return (
    <div className="w-full h-full flex flex-col bg-surface-1">
      {/* Tab 切换：按角色展示不同 Tab（Logo/角色切换/搜索/用户入口已迁至全局 TopBar） */}
      <div className="flex gap-1 px-3 pt-2 pb-2">
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
            {/* 文章库并入大纲：章节正文统一在大纲面板管理，作品库只列作品 */}
            <NovelList />
          </div>
          {/* 知识图谱面板 */}
          <KnowledgePanel />
        </>
      )}
      {activeTab === 'outline' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ErrorBoundary label="大纲面板" resetKey={currentNovelId}>
            <OutlinePanel />
          </ErrorBoundary>
        </div>
      )}
      {activeTab === 'memory' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* 自媒体角色使用全局记忆，其余角色按作品隔离 */}
          <MemoryPanel scope={role === 'media' ? 'media' : 'novel'} />
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
