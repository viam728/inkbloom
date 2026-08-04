import React, { useEffect, useRef, useCallback } from 'react';
import { useAIStore } from '@/stores/ai-store';
import { useNovelStore } from '@/stores/novel-store';
import type { RewriteAction } from '@/types';

interface ContextMenuProps {
  /** The selected plain text in the editor (empty = nothing selected). */
  selectedText: string;
  /** Callback to position the menu (clientX, clientY from the contextmenu event). */
  position: { x: number; y: number } | null;
  /** Called when the menu is dismissed (click outside or action taken). */
  onClose: () => void;
}

interface MenuItem {
  label: string;
  action: RewriteAction;
  icon: string;
}

const MENU_ITEMS: MenuItem[] = [
  { label: 'AI 润色', action: 'polish', icon: '✨' },
  { label: 'AI 扩写', action: 'expand', icon: '📖' },
  { label: 'AI 缩写', action: 'condense', icon: '📝' },
  { label: 'AI 去AI味', action: 'humanize', icon: '🧑‍💻' },
];

const ContextMenu: React.FC<ContextMenuProps> = ({ selectedText, position, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRewrite = useAIStore((s) => s.triggerRewrite);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);

  // Close on click outside
  useEffect(() => {
    if (!position) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [position, onClose]);

  const handleAction = useCallback(
    (action: RewriteAction) => {
      if (!currentNovel || !currentChapter || !selectedText) return;
      triggerRewrite({
        novelId: currentNovel.id,
        chapterId: currentChapter.id,
        selectedText,
        action,
      });
      onClose();
    },
    [currentNovel, currentChapter, selectedText, triggerRewrite, onClose],
  );

  if (!position || !selectedText) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1.5 text-xs text-neutral-500 border-b border-neutral-700 mb-1">
        AI 操作
      </div>
      {MENU_ITEMS.map((item) => (
        <button
          key={item.action}
          type="button"
          onClick={() => handleAction(item.action)}
          className="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors flex items-center gap-2"
        >
          <span>{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ContextMenu;
