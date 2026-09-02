import React, { useEffect, useMemo } from 'react';
import { MessageSquareText, Palette, MessageSquareQuote, Sparkles, Images, Anchor } from 'lucide-react';
import AIChatPanel from '@/components/ai/AIChatPanel';
import AIGCPanel from '@/components/aigc/AIGCPanel';
import ReviewPanel from '@/components/review/ReviewPanel';
import TitleFactoryPanel from '@/components/media/TitleFactoryPanel';
import GalleryGrid from '@/components/gallery/GalleryGrid';
import ForeshadowTracker from '@/components/knowledge/ForeshadowTracker';
import { useUIStore, type RightTab } from '@/stores/ui-store';

const NOVELIST_TABS: { id: RightTab; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'AI 助手', icon: <MessageSquareText size={14} /> },
  { id: 'review', label: '批注评审', icon: <MessageSquareQuote size={14} /> },
  { id: 'tracker', label: '伏笔', icon: <Anchor size={14} /> },
  { id: 'aigc', label: '图片生成', icon: <Palette size={14} /> },
  { id: 'gallery', label: '图床', icon: <Images size={14} /> },
];

// 自媒体创作者：标题工厂替代批注评审，侧重传播效率
const MEDIA_TABS: { id: RightTab; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'AI 助手', icon: <MessageSquareText size={14} /> },
  { id: 'title', label: '标题工厂', icon: <Sparkles size={14} /> },
  { id: 'aigc', label: '配图生成', icon: <Palette size={14} /> },
  { id: 'gallery', label: '图床', icon: <Images size={14} /> },
];

const RightPanel: React.FC = () => {
  const role = useUIStore((s) => s.role);
  const rightCollapsed = useUIStore((s) => s.rightCollapsed);
  // activeTab 改读全局 ui-store，供命令面板 / AIGC 等外部跳转直达指定 Tab
  const activeTab = useUIStore((s) => s.activeRightTab);
  const setActiveTab = useUIStore((s) => s.setActiveRightTab);

  // 角色差异：小说作者→批注评审；自媒体创作者→标题工厂
  const tabs = useMemo(() => (role === 'media' ? MEDIA_TABS : NOVELIST_TABS), [role]);

  // 角色切换后若当前 Tab 不存在则回退
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab('chat');
  }, [tabs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for toolbar / palette events
  useEffect(() => {
    const showAigc = () => setActiveTab('aigc');
    const showReview = () => setActiveTab('review');
    window.addEventListener('inkbloom:show-aigc', showAigc);
    window.addEventListener('inkbloom:show-review', showReview);
    return () => {
      window.removeEventListener('inkbloom:show-aigc', showAigc);
      window.removeEventListener('inkbloom:show-review', showReview);
    };
  }, [setActiveTab]);

  return (
    <div className="w-full h-full border-l border-white/6 flex flex-col bg-surface-1">
      {/* Tab bar */}
      <div className="flex p-1.5 gap-1 border-b border-white/6">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                active
                  ? 'bg-brand-600/20 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
              }`}
            >
              {tab.icon}
              {tab.label}
              {active && (
                <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-gradient-to-r from-indigo-400 to-pink-400" />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {activeTab === 'chat' && <AIChatPanel />}
        {activeTab === 'review' && <ReviewPanel />}
        {activeTab === 'tracker' && <ForeshadowTracker />}
        {activeTab === 'title' && <TitleFactoryPanel />}
        {activeTab === 'aigc' && <AIGCPanel />}
        {activeTab === 'gallery' && (
          <GalleryGrid mode="manage" compact visible={!rightCollapsed} />
        )}
      </div>
    </div>
  );
};

export default RightPanel;
