import React from 'react';
import { X, Minus, Plus } from 'lucide-react';
import { useReaderStore, type ReaderTheme } from '@/stores/reader-store';

/**
 * 阅读设置浮层（字号 / 行距 / 主题）
 * 偏好持久化在 reader-store（独立 persist key inkbloom-reader）。
 */
const ReaderSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { fontSize, lineHeight, theme, setFontSize, setLineHeight, setTheme } = useReaderStore();

  const themes: { id: ReaderTheme; label: string; bg: string }[] = [
    { id: 'dark', label: '夜间', bg: 'bg-surface-0' },
    { id: 'sepia', label: '护眼', bg: 'bg-amber-50' },
    { id: 'light', label: '日间', bg: 'bg-white' },
  ];

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-md bg-surface-1 rounded-t-2xl border border-white/8 p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-200">阅读设置</h3>
          <button type="button" onClick={onClose} className="p-1 rounded text-neutral-500 hover:text-neutral-200">
            <X size={16} />
          </button>
        </div>

        {/* 字号 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">字号</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setFontSize(fontSize - 1)}
              className="p-1.5 rounded bg-white/6 text-neutral-300 hover:bg-white/10"
            >
              <Minus size={14} />
            </button>
            <span className="text-sm text-neutral-200 w-8 text-center">{fontSize}</span>
            <button
              type="button"
              onClick={() => setFontSize(fontSize + 1)}
              className="p-1.5 rounded bg-white/6 text-neutral-300 hover:bg-white/10"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* 行距 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">行距</span>
          <div className="flex items-center gap-2">
            {[1.6, 1.85, 2.0, 2.2].map((lh) => (
              <button
                key={lh}
                type="button"
                onClick={() => setLineHeight(lh)}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                  Math.abs(lineHeight - lh) < 0.01
                    ? 'bg-brand-600/25 text-brand-300'
                    : 'bg-white/6 text-neutral-400 hover:bg-white/10'
                }`}
              >
                {lh}
              </button>
            ))}
          </div>
        </div>

        {/* 主题 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">主题</span>
          <div className="flex items-center gap-2">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                  theme === t.id ? 'bg-brand-600/25 text-brand-300' : 'bg-white/6 text-neutral-400 hover:bg-white/10'
                }`}
              >
                <span className={`w-3 h-3 rounded-full ${t.bg} border border-white/10`} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReaderSettings;
