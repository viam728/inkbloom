import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import DiffViewer from '@/components/editor/DiffViewer';
import { useHistoryStore } from '@/stores/history-store';
import { useTabStore, chapterTabKey } from '@/stores/tab-store';
import {
  fetchChapterContent,
  getChapterVersion,
  type ChapterVersionDetail,
} from '@/services/history-client';

/**
 * 版本对比（业务方案 v3 E1，施工任务 A06）
 *
 * 复用编辑器的 DiffViewer：左为历史版本，右为当前正文。
 * 「回滚到此版本」即 DiffViewer 的 accept，「关闭」即 reject。
 */

interface VersionCompareProps {
  open: boolean;
  chapterId: number;
  versionId: number;
  onClose: () => void;
  /** 回滚成功后回调：由宿主负责刷新编辑器草稿与提示 */
  onRestored?: () => Promise<void> | void;
}

/** 去掉 HTML 标签取纯文本用于字符级 diff（与 countDraftWords 的口径一致） */
function htmlToText(html: string): string {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

const VersionCompare: React.FC<VersionCompareProps> = ({
  open,
  chapterId,
  versionId,
  onClose,
  onRestored,
}) => {
  const [detail, setDetail] = useState<ChapterVersionDetail | null>(null);
  const [current, setCurrent] = useState('');
  const [loading, setLoading] = useState(false);
  const { restore, restoring } = useHistoryStore();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [v, content] = await Promise.all([
          getChapterVersion(chapterId, versionId),
          fetchChapterContent(chapterId),
        ]);
        if (!cancelled) {
          setDetail(v);
          setCurrent(content);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chapterId, versionId]);

  const originalText = useMemo(() => (detail ? htmlToText(detail.content ?? '') : ''), [detail]);
  const modifiedText = useMemo(() => htmlToText(current), [current]);

  const handleRestore = useCallback(async () => {
    const ok = await restore(chapterId, versionId);
    if (!ok) return;
    // 回滚会新增一条 rollback 版本，正文已变更，同步刷新 tab 草稿
    const content = await fetchChapterContent(chapterId);
    useTabStore.getState().updateTab(chapterTabKey(chapterId), {
      draft: content,
      isDirty: false,
      saveStatus: 'saved',
    });
    await onRestored?.();
  }, [restore, chapterId, versionId, onRestored]);

  if (!open) return null;

  if (loading || !detail) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
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
      acceptText={restoring ? '回滚中…' : '回滚到此版本'}
      rejectText="关闭"
    />
  );
};

export default VersionCompare;
