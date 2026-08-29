import React from 'react';
import { BookMarked, Megaphone, StickyNote } from 'lucide-react';
import { useUIStore, type CreatorRole } from '@/stores/ui-store';

export interface RoleOption {
  value: CreatorRole;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

export const ROLES: RoleOption[] = [
  {
    value: 'novelist',
    label: '小说作者',
    desc: '章节管理 · 世界观 · 节奏分析',
    icon: <BookMarked size={14} />,
  },
  {
    value: 'media',
    label: '自媒体作者',
    desc: '平台分发 · 图文 AIGC · 标题党',
    icon: <Megaphone size={14} />,
  },
  {
    value: 'memo',
    label: '简约随记',
    desc: '快速捕捉灵感 · 零负担',
    icon: <StickyNote size={14} />,
  },
];

/**
 * 创作者角色切换器：顶栏内平铺的分段控件。
 *
 * 早先版本是点击展开的下拉菜单，但顶栏高度固定（h-11）且带 backdrop-blur，
 * 会创建独立 stacking context —— 弹出的浮层被限制在 44px 的顶栏层级内，
 * 溢出部分被下方的编辑区/侧栏盖住（"点开后被遮蔽"）。
 *
 * 改为平铺后既没有浮层溢出问题，切换也从两次点击降为一次。各场景描述
 * 改由 title 提示承载。
 */
const RoleSwitcher: React.FC = () => {
  const role = useUIStore((s) => s.role);
  const setRole = useUIStore((s) => s.setRole);

  return (
    <div
      role="radiogroup"
      aria-label="创作场景"
      className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/4 border border-white/6"
    >
      {ROLES.map((r) => {
        const selected = r.value === role;
        return (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={r.desc}
            onClick={() => setRole(r.value)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all duration-150 ${
              selected
                ? 'bg-brand-600/25 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/6'
            }`}
          >
            <span className="shrink-0">{r.icon}</span>
            {/* 窄屏收起文字，仅留图标（完整说明见 title） */}
            <span className="hidden lg:inline whitespace-nowrap">{r.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default RoleSwitcher;
