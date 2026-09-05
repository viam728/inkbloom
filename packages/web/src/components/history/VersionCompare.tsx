import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import DiffViewer from '@/components/editor/DiffViewer';
import { useTabStore, chapterTabKey, countDraftWords } from '@/stores/tab-store';
import { toast } from '@/components/common/Toast';
import {
  fetchChapterContent,
  getVersionContent,
  checkoutPublished,
} from '@/services/history-client';
import { putAutoSnapshot } from '@/utils/temp-branch';

/**
 * 版本对比（备忘录 L61 三态）：左 = 发布分支（不可变快照），右 = 草稿分支
 * （工作区）。「回滚到发布版」= 先把当前草稿压入浏览器临时分支（可撤销），
 * 再 checkout 发布 blob 到工作区。
 */

interface VersionCompareProps {
  open: boolean;
  chapterId: number;
  onClose: () => void;
  /** 回滚成功后回调：由宿主负责刷新编辑器草稿与提示 */
  onRestored?: () => Promise<void> | void;
}

/** HTML → 纯文本按行（diff 以行为单位；与编辑器行语义一致） */
function htmlToText(html: string): string {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 刷新 tab 草稿为服务器最新正文 */
async function refreshTabFromServer(chapterId: number): Promise<string> {
  const content = await fetchChapterContent(chapterId);
  useTabStore.getState().updateTab(chapterTabKey(chapterId), {
    draft: content,
    wordCount: countDraftWords(content),
    isDirty: false,
    saveStatus: 'saved',
  });
  return content;
}

const VersionCompare: React.FC<VersionCompareProps> = ({
  open,
  chapterId,
  onClose,
  onRestored,
}) => {
  const [publishedText, setPublishedText] = useState('');
  const [draftText, setDraftText] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [pub, draft] = await Promise.all([
          getVersionContent(chapterId, 'published'),
          fetchChapterContent(chapterId),
        ]);
        if (!cancelled) {
          setPublishedText(pub);
          setDraftText(draft);
        }
      } catch (e) {
        if (!cancelled) {
          toast.show(e instanceof Error ? e.message : '对比内容加载失败', 'error');
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chapterId, onClose]);

  const originalText = useMemo(() => htmlToText(publishedText), [publishedText]);
  const modifiedText = useMemo(() => htmlToText(draftText), [draftText]);

  /** 回滚 = 先暂存当前草稿（临时分支，可撤销）→ checkout 发布 blob */
  const handleRestore = useCallback(async () => {
    setRestoring(true);
    try {
      const current = await fetchChapterContent(chapterId);
      if (current.trim()) {
        putAutoSnapshot(chapterId, current, '回滚到发布版前');
        toast.show('当前草稿已暂存到临时分支，可随时撤销', 'info');
      }
      await checkoutPublished(chapterId);
      await refreshTabFromServer(chapterId);
      toast.show('已回滚到发布版本', 'success');
      await onRestored?.();
      onClose();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '回滚失败', 'error');
    } finally {
      setRestoring(false);
    }
  }, [chapterId, onRestored, onClose]);

  if (!open) return null;

  if (loading) {
    return (
      <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60">
        <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <DiffViewer
      original={originalText}
      modified={modifiedText}
      onAccept={() => void handleRestore()}
      onReject={onClose}
      title="版本对比"
      acceptText={restoring ? '回滚中…' : '回滚到发布版'}
      rejectText="关闭"
      leftLabel="发布版（不可变快照）"
      rightLabel="编辑版（草稿工作区）"
    />
  );
};

export default VersionCompare;


