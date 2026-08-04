import React from 'react';
import { Loader2, FilePlus2, Copy, Sparkles, Link2 } from 'lucide-react';
import Modal from '@/components/common/Modal';

interface DraftPreviewModalProps {
  open: boolean;
  /** 大纲标题（成稿章节名） */
  title: string;
  /** 初稿 HTML，null 表示生成中 */
  draft: string | null;
  /** 引用的作品记忆条目 */
  memoryRefs: string[];
  /** 正在创建章节写入 */
  writing: boolean;
  onClose: () => void;
  /** 创建章节并写入初稿 */
  onWrite: () => void;
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, '');

const DraftPreviewModal: React.FC<DraftPreviewModalProps> = ({
  open,
  title,
  draft,
  memoryRefs,
  writing,
  onClose,
  onWrite,
}) => {
  const wordCount = draft ? (stripHtml(draft).match(/[\u4e00-\u9fff]/g) || []).length : 0;

  const handleCopy = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(stripHtml(draft).replace(/\n{3,}/g, '\n\n'));
    } catch {
      /* ignore */
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-1.5"><Sparkles size={14} className="text-fuchsia-300" />扩写初稿 · {title || '未命名章节'}</span>} width="620px">
      <div className="px-5 py-4">
        {/* 生成中 */}
        {draft === null ? (
          <div className="space-y-3 py-6 animate-fade-in">
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <Loader2 size={15} className="animate-spin text-fuchsia-300" />
              正在根据大纲与设定扩写初稿…
            </div>
            <div className="skeleton h-3.5 rounded w-full" />
            <div className="skeleton h-3.5 rounded w-5/6" />
            <div className="skeleton h-3.5 rounded w-4/6" />
            <div className="skeleton h-3.5 rounded w-full" />
            <div className="skeleton h-3.5 rounded w-3/6" />
          </div>
        ) : (
          <>
            {/* 引用的设定 */}
            {memoryRefs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <span className="flex items-center gap-1 text-[10px] text-neutral-500">
                  <Link2 size={10} />
                  已注入设定：
                </span>
                {memoryRefs.map((name) => (
                  <span
                    key={name}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-fuchsia-500/12 text-fuchsia-300 border border-fuchsia-500/20"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}

            {/* 初稿内容 */}
            <div className="max-h-[42vh] overflow-y-auto rounded-xl bg-surface-2 border border-white/6 px-4 py-3">
              <div
                className="text-[13px] leading-7 text-neutral-200 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-neutral-100 [&_h2]:mb-2 [&_p]:mb-2.5 [&_p:last-child]:mb-0"
                dangerouslySetInnerHTML={{ __html: draft }}
              />
            </div>

            {/* 底部操作 */}
            <div className="flex items-center gap-2 mt-4">
              <span className="text-[11px] text-neutral-500">约 {wordCount} 字</span>
              <div className="flex-1" />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-neutral-300 bg-white/6 hover:bg-white/12 border border-white/8 transition-colors"
              >
                <Copy size={12} />
                复制纯文本
              </button>
              <button
                onClick={onWrite}
                disabled={writing}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:opacity-50 transition-all shadow-lg shadow-brand-600/20"
              >
                {writing ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    写入中…
                  </>
                ) : (
                  <>
                    <FilePlus2 size={12} />
                    创建章节并写入
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default DraftPreviewModal;
