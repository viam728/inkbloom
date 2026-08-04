import React, { useRef, useState, useEffect } from 'react';
import { FORMAT_OPTIONS } from '@/types/format';
import { convertFormat } from '@/services/format-client';
import { useNovelStore } from '@/stores/novel-store';
import { useEditorStore } from '@/stores/editor-store';
import { useToast } from '@/components/common/Toast';

// 复制选项：只展示适合复制的格式
const COPY_FORMATS = FORMAT_OPTIONS.filter((f) =>
  ['wechat', 'zhihu', 'markdown', 'html'].includes(f.id)
);

const CopyMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const content = useEditorStore((s) => s.content);
  const { showToast } = useToast();

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleCopy = async (formatId: string) => {
    if (!currentChapter) {
      showToast('请先选择章节', 'error');
      return;
    }
    setOpen(false);

    try {
      // 尝试使用 content_json（TipTap AST），如果不可用则用 HTML
      let contentJson: unknown;
      if (currentChapter.content_json) {
        try {
          contentJson = JSON.parse(currentChapter.content_json);
        } catch {
          // fallback below
        }
      }
      if (!contentJson && content) {
        // Wrap HTML content as plain text in TipTap doc for conversion
        contentJson = {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: content.replace(/<[^>]*>/g, '') }] }],
        };
      }
      if (!contentJson) {
        showToast('没有可复制的内容', 'error');
        return;
      }

      const converted = await convertFormat(contentJson, formatId);
      const format = FORMAT_OPTIONS.find((f) => f.id === formatId);
      const mimeType = format?.mimeType ?? 'text/plain';

      if (mimeType === 'text/html') {
        await navigator.clipboard.write([
          new ClipboardItem({ [mimeType]: new Blob([converted], { type: mimeType }) }),
        ]);
      } else {
        await navigator.clipboard.writeText(converted);
      }

      showToast(`已复制为 ${format?.name ?? formatId}`, 'success');
    } catch (e) {
      console.error('Copy failed', e);
      showToast('复制失败', 'error');
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-2 py-1 rounded text-sm font-medium text-neutral-300 hover:bg-neutral-700 hover:text-white transition-colors"
        title="复制到..."
      >
        复制
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 overflow-hidden">
          {COPY_FORMATS.map((fmt) => (
            <button
              key={fmt.id}
              onClick={() => handleCopy(fmt.id)}
              className="w-full text-left px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
            >
              复制到{fmt.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CopyMenu;
