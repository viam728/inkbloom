import React from 'react';
import { Brain, ListOrdered, Megaphone, Lightbulb, Network } from 'lucide-react';
import KnowledgePanel from '../knowledge/KnowledgePanel';
import MemoryPanel from '../memory/MemoryPanel';
import OutlinePanel from '../outline/OutlinePanel';
import MediaLibraryPanel from '../media/MediaLibraryPanel';
import TopicPoolPanel from '../media/TopicPoolPanel';
import ArchitecturePanel from '../architecture/ArchitecturePanel';
import WorksBar from './WorksBar';
import ErrorBoundary from '../common/ErrorBoundary';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore, type LeftTab, type CreatorRole } from '@/stores/ui-store';

/**
 * 左侧板（备忘录 L61 作品库迁移 + 架构栏目）：
 *  · 小说作者：顶部为作品集成标签条（WorksBar：+ 新建 / 作品库下展 / 作品项
 *    标签右列），其下为选项 Tab——大纲 / 架构（大纲右侧）/ 记忆；
 *  · 自媒体作者：内容库 / 选题池 / 记忆（无作品集成条）。
 *  · 知识图谱面板随大纲 Tab 展示（原作品库 Tab 的承载职责并入 WorksBar）。
 */

/** 小说作者：大纲 / 架构 / 记忆（作品库已迁移至顶部 WorksBar） */
const NOVELIST_TABS: { id: LeftTab; label: string; icon: React.ReactNode }[] = [
  { id: 'outline', label: '大纲', icon: <ListOrdered size={13} /> },
  { id: 'architecture', label: '架构', icon: <Network size={13} /> },
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
      {/* 作品集成标签条（仅小说作者；自原作品库 Tab 迁入） */}
      {role === 'novelist' && <WorksBar />}

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
      {activeTab === 'outline' && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-hidden">
            <ErrorBoundary label="大纲面板" resetKey={currentNovelId}>
              <OutlinePanel />
            </ErrorBoundary>
          </div>
          {/* 知识图谱面板（原作品库 Tab 承载，随大纲展示） */}
          <KnowledgePanel />
        </div>
      )}
      {activeTab === 'architecture' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ErrorBoundary label="架构面板" resetKey={currentNovelId}>
            <ArchitecturePanel />
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
