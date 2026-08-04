import React, { useState } from 'react';
import { FORMAT_OPTIONS } from '@/types/format';
import { exportChapter, exportNovel } from '@/services/format-client';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const ExportDialog: React.FC<ExportDialogProps> = ({ open, onClose }) => {
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const { showToast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [scope, setScope] = useState<'chapter' | 'novel'>('chapter');

  if (!open) return null;

  const handleExport = async (formatId: string) => {
    setExporting(true);
    try {
      let blob: Blob;
      let filename: string;

      if (scope === 'chapter' && currentChapter) {
        blob = await exportChapter(currentChapter.id, formatId);
        filename = `${currentChapter.title}`;
      } else if (scope === 'novel' && currentNovel) {
        blob = await exportNovel(currentNovel.id, formatId);
        filename = `${currentNovel.title}`;
      } else {
        showToast('请先选择章节或小说', 'error');
        return;
      }

      const format = FORMAT_OPTIONS.find((f) => f.id === formatId);
      const ext = formatId === 'markdown' ? '.md' : formatId === 'qidian' ? '.txt' : '.html';
      if (scope === 'novel') {
        filename += '.zip';
      } else {
        filename += ext;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`导出 ${format?.name ?? formatId} 成功`, 'success');
      onClose();
    } catch (e) {
      console.error('Export failed', e);
      showToast('导出失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-800 rounded-xl shadow-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-100">导出</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white text-xl leading-none">
            &times;
          </button>
        </div>

        {/* Scope selector */}
        <div className="flex gap-2 mb-4">
          <button
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              scope === 'chapter'
                ? 'bg-indigo-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
            onClick={() => setScope('chapter')}
            disabled={!currentChapter}
          >
            当前章节
          </button>
          <button
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              scope === 'novel'
                ? 'bg-indigo-600 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
            onClick={() => setScope('novel')}
            disabled={!currentNovel}
          >
            整本小说
          </button>
        </div>

        {/* Format list */}
        <div className="flex flex-col gap-2">
          {FORMAT_OPTIONS.map((fmt) => (
            <button
              key={fmt.id}
              onClick={() => handleExport(fmt.id)}
              disabled={exporting}
              className="flex items-center gap-3 p-3 rounded-lg bg-neutral-700/50 hover:bg-neutral-700 transition-colors text-left disabled:opacity-50"
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-neutral-100">{fmt.name}</div>
                <div className="text-xs text-neutral-400">{fmt.description}</div>
              </div>
              <span className="text-xs text-neutral-500">{exporting ? '导出中...' : '导出'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
