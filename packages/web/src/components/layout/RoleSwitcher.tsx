import React, { useEffect, useRef, useState } from 'react';
import { BookMarked, Megaphone, StickyNote, Check, ChevronDown } from 'lucide-react';
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

/** 创作者角色切换器：简约可展开胶囊（向下展开） */
const RoleSwitcher: React.FC<{ align?: 'left' | 'right' }> = ({ align = 'left' }) => {
  const role = useUIStore((s) => s.role);
  const setRole = useUIStore((s) => s.setRole);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = ROLES.find((r) => r.value === role) ?? ROLES[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      {/* 向下展开的角色列表 */}
      {open && (
        <div
          className={`absolute top-full mt-2 ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'} w-60 glass-panel rounded-xl p-1.5 z-40 animate-scale-in`}
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            创作场景
          </p>
          {ROLES.map((r) => {
            const selected = r.value === role;
            return (
              <button
                key={r.value}
                onClick={() => {
                  setRole(r.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                  selected ? 'bg-brand-600/15' : 'hover:bg-white/6'
                }`}
              >
                <span
                  className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center ${
                    selected ? 'bg-brand-500/25 text-brand-300' : 'bg-white/6 text-neutral-400'
                  }`}
                >
                  {r.icon}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={`block text-xs font-medium ${
                      selected ? 'text-brand-300' : 'text-neutral-200'
                    }`}
                  >
                    {r.label}
                  </span>
                  <span className="block text-[10px] text-neutral-500 truncate">{r.desc}</span>
                </span>
                {selected && <Check size={13} className="shrink-0 text-brand-400" />}
              </button>
            );
          })}
        </div>
      )}

      {/* 收起态胶囊 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="切换创作场景"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all duration-150 ${
          open
            ? 'bg-brand-600/20 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
            : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/6'
        }`}
      >
        {current.icon}
        <span>{current.label}</span>
        <ChevronDown
          size={12}
          className={`text-neutral-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
    </div>
  );
};

export default RoleSwitcher;
