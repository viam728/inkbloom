import React, { useEffect, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import Kbd from '@/components/common/Kbd';
import { useCommandItems, type PaletteItem } from './useCommandItems';

const CommandPalette: React.FC = () => {
  const paletteOpen = useUIStore((s) => s.paletteOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // items 构建与 TopBar 居中搜索共用同一 hook
  const items = useCommandItems(query);

  const close = () => {
    setPaletteOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (paletteOpen) {
      setQuery('');
      setActiveIndex(0);
      // 等渲染后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 激活项保持可见
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const execute = (item: PaletteItem) => {
    close();
    item.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[activeIndex]) execute(items[activeIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  if (!paletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" onMouseDown={close}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-fade-in" />
      <div
        className="relative glass-panel rounded-xl w-[560px] max-w-[90vw] animate-scale-in flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/8">
          <Search size={16} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索作品、章节或命令…"
            className="flex-1 bg-transparent text-sm text-neutral-100 placeholder-neutral-500 outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">
              没有匹配的结果
            </div>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => execute(item)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                i === activeIndex ? 'bg-brand-600/20' : ''
              }`}
            >
              <span className="shrink-0 w-7 h-7 rounded-md bg-white/5 flex items-center justify-center">
                {item.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-neutral-200 truncate">{item.title}</span>
              </span>
              {item.subtitle && (
                <span className="shrink-0 text-[11px] text-neutral-500">{item.subtitle}</span>
              )}
              {i === activeIndex && <CornerDownLeft size={13} className="text-neutral-500 shrink-0" />}
            </button>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/8 text-[11px] text-neutral-500">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 导航
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd> 执行
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
