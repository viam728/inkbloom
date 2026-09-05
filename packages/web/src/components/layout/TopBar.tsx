import React, { useEffect, useRef, useState } from 'react';
import { Search, Sparkles, Maximize2, Minimize2, CornerDownLeft, Globe } from 'lucide-react';
import RoleSwitcher from './RoleSwitcher';
import UserMenu from './UserMenu';
import { useCommandItems, type PaletteItem } from './useCommandItems';
import { useUIStore } from '@/stores/ui-store';

/** 下拉最多展示条数（空查询时给常用命令一个紧凑预览） */
const MAX_DROPDOWN_ITEMS = 8;

/** 居中搜索：聚焦/输入时下拉展示结果（作品/章节跳转 + 命令），Enter 执行，Esc 关闭 */
const TopSearch: React.FC = () => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useCommandItems(query);
  const visible = items.slice(0, MAX_DROPDOWN_ITEMS);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const execute = (item: PaletteItem) => {
    close();
    inputRef.current?.blur();
    item.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible[activeIndex]) execute(visible[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/4 border border-white/6 focus-within:border-brand-500/50 focus-within:bg-white/6 focus-within:shadow-[0_0_0_3px_rgba(99,102,241,0.12)] transition-all">
        <Search size={13} className="text-neutral-500 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="搜索或输入命令… (Ctrl+K)"
          className="flex-1 bg-transparent text-xs text-neutral-100 placeholder-neutral-600 outline-none"
        />
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-2 glass-panel rounded-xl overflow-hidden shadow-2xl shadow-black/40 animate-scale-in z-50">
          <div className="max-h-[320px] overflow-y-auto py-1">
            {visible.length === 0 && (
              <div className="px-4 py-5 text-center text-xs text-neutral-500">没有匹配的结果</div>
            )}
            {visible.map((item, i) => (
              <button
                key={item.id}
                onClick={() => execute(item)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  i === activeIndex ? 'bg-brand-600/20' : ''
                }`}
              >
                <span className="shrink-0 w-6 h-6 rounded-md bg-white/5 flex items-center justify-center">
                  {item.icon}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-neutral-200 truncate">{item.title}</span>
                </span>
                {item.subtitle && (
                  <span className="shrink-0 text-[10px] text-neutral-500">{item.subtitle}</span>
                )}
                {i === activeIndex && (
                  <CornerDownLeft size={12} className="text-neutral-500 shrink-0" />
                )}
              </button>
            ))}
          </div>
          <div className="px-3 py-1.5 border-t border-white/8 text-[10px] text-neutral-600 flex gap-3">
            <span>↑↓ 选择</span>
            <span>Enter 执行</span>
            <span>Esc 关闭</span>
            <span className="ml-auto">Ctrl+K 打开完整面板</span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 全局顶栏（约 44px）：左区 Logo + AI 标 + 社区入口 → 中区居中搜索 → 右区创作场景切换 + 最大化 + UserMenu。
 * 左右两区等宽，中区因此真正居中。
 * 专注模式下整体隐藏；随记模式同样挂载（MemoPad 内部重复元素已移除）。
 */
const TopBar: React.FC = () => {
  const focusMode = useUIStore((s) => s.focusMode);
  const role = useUIStore((s) => s.role);
  const editorMaximized = useUIStore((s) => s.editorMaximized);
  const toggleEditorMaximized = useUIStore((s) => s.toggleEditorMaximized);

  if (focusMode) return null;

  // 三段式布局：左右两区等宽（flex-1），中间搜索固定宽度，从而真正居中。
  // 之前搜索框用 flex-1 + mx-auto，flex-1 已经吃满剩余空间，mx-auto 无空间
  // 可分配，实际表现是紧贴左侧元素、视觉偏左。
  return (
    <div className="relative z-30 shrink-0 h-11 flex items-center gap-3 px-3 border-b border-white/6 bg-surface-1/80 backdrop-blur">
      {/* 左区：Logo + AI 标 + 社区入口 */}
      <div className="flex-1 flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center text-[15px] shadow-lg shadow-indigo-500/20">
            🌸
          </div>
          <h1 className="text-[15px] font-bold bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
            InkBloom
          </h1>
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/20">
            <Sparkles size={10} />
            AI
          </span>
        </div>

        {/* 社区入口：公开发现页（AI 标右侧） */}
        <a
          href="/discover"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-neutral-400 hover:text-neutral-100 hover:bg-white/8 transition-colors"
          title="浏览社区作品"
        >
          <Globe size={14} />
          社区
        </a>
      </div>

      {/* 中区：居中搜索（缩短 1/4：480→360 / 38vw→28.5vw） */}
      <div className="shrink-0 w-[min(360px,28.5vw)]">
        <TopSearch />
      </div>

      {/* 右区：创作场景切换 + 最大化 + 用户入口 */}
      <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
        {/* 创作场景切换：平铺分段控件（移至右区，最大化按钮左侧） */}
        <div className="shrink-0">
          <RoleSwitcher />
        </div>

        {/* 编辑区最大化/还原（随记模式无侧栏，不参与） */}
        {role !== 'memo' && (
          <button
            type="button"
            onClick={toggleEditorMaximized}
            title={editorMaximized ? '还原布局 (退出编辑区最大化)' : '最大化编辑区（隐藏侧栏）'}
            className={`shrink-0 p-1.5 rounded-md transition-all duration-150 hover:bg-white/8 active:scale-95 ${
              editorMaximized
                ? '!bg-brand-600/25 !text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {editorMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}

        <div className="shrink-0">
          <UserMenu compact />
        </div>
      </div>
    </div>
  );
};

export default TopBar;
