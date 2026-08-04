import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
  /** 顶部偏移定位（用于命令面板样式） */
  top?: boolean;
}

const Modal: React.FC<ModalProps> = ({ open, onClose, title, children, width = '420px', top = false }) => {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex ${top ? 'items-start pt-[14vh]' : 'items-center'} justify-center`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-fade-in" onMouseDown={onClose} />

      {/* 面板 */}
      <div
        className="relative glass-panel rounded-xl animate-scale-in flex flex-col max-h-[70vh]"
        style={{ width }}
        role="dialog"
        aria-modal="true"
      >
        {title !== undefined && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
            <h3 className="text-sm font-semibold text-neutral-200">{title}</h3>
            <button
              onClick={onClose}
              className="p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
              title="关闭"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

export default Modal;
