import React, { useEffect } from 'react';
import { X, Download, FilePlus2 } from 'lucide-react';

interface ImagePreviewProps {
  src: string;
  prompt?: string;
  onClose: () => void;
  onDownload?: () => void;
  onInsert?: () => void;
}

const ImagePreview: React.FC<ImagePreviewProps> = ({
  src,
  prompt,
  onClose,
  onDownload,
  onInsert,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative max-w-[86vw] max-h-[88vh] flex flex-col glass-panel rounded-2xl overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 backdrop-blur text-neutral-300 hover:text-white hover:bg-black/70 flex items-center justify-center transition-colors"
          title="关闭（Esc）"
        >
          <X size={15} />
        </button>

        <img
          src={src}
          alt={prompt || 'Preview'}
          className="max-w-full max-h-[70vh] object-contain bg-surface-0"
        />

        {/* Footer: prompt + actions */}
        <div className="flex items-center gap-3 px-4 py-3 border-t border-white/6 bg-surface-1/90">
          {prompt && (
            <p className="flex-1 min-w-0 text-xs text-neutral-400 line-clamp-2">{prompt}</p>
          )}
          <div className="flex gap-2 shrink-0">
            {onInsert && (
              <button
                onClick={onInsert}
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 text-white text-xs font-medium rounded-lg transition-all"
              >
                <FilePlus2 size={13} />
                插入编辑器
              </button>
            )}
            {onDownload && (
              <button
                onClick={onDownload}
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-white/8 hover:bg-white/14 text-neutral-200 text-xs rounded-lg border border-white/8 transition-colors"
              >
                <Download size={13} />
                下载
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImagePreview;
