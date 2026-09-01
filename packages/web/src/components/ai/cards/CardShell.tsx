import React from 'react';
import type { ReactNode } from 'react';

export interface CardShellBadge {
  text: string;
  tone: 'violet' | 'green' | 'red' | 'gray';
}

interface CardShellProps {
  title: string;
  icon: ReactNode;
  badge?: CardShellBadge;
  children: ReactNode;
}

const BADGE_CLASSES: Record<CardShellBadge['tone'], string> = {
  violet: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  red: 'bg-red-500/15 text-red-300 border-red-500/30',
  gray: 'bg-white/8 text-neutral-400 border-white/12',
};

/**
 * 对话内消息卡片共用外壳：标题栏（icon + 标题 + 状态 badge）+ 暗色容器。
 * 视觉 token 对齐旧面板 StoryWorkflowPanel（bg-white/4 border-white/8 rounded-xl）。
 */
const CardShell: React.FC<CardShellProps> = ({ title, icon, badge, children }) => {
  return (
    <div className="rounded-xl bg-white/4 border border-white/8 overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-brand-300 shrink-0">{icon}</span>
        <span className="text-xs font-medium text-neutral-200 flex-1 min-w-0 truncate">{title}</span>
        {badge && (
          <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${BADGE_CLASSES[badge.tone]}`}>
            {badge.text}
          </span>
        )}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </div>
  );
};

export default CardShell;
