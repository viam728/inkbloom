import React, { useMemo } from 'react';

interface DiffViewerProps {
  original: string;
  modified: string;
  onAccept: () => void;
  onReject: () => void;
  /**
   * 以下三项为可选文案覆盖（业务方案 v3 E1）。
   * 缺省时保持 AI 改写场景的原文案，版本历史对比复用本组件时传入自己的措辞。
   */
  title?: string;
  acceptText?: string;
  rejectText?: string;
}

interface DiffSegment {
  type: 'equal' | 'delete' | 'insert';
  text: string;
}

/**
 * Simple character-level diff using Longest Common Subsequence (LCS).
 * Optimised for short texts (selected paragraphs).
 */
function computeDiff(original: string, modified: string): DiffSegment[] {
  // Build LCS table on character arrays
  const a = [...original];
  const b = [...modified];
  const m = a.length;
  const n = b.length;

  // For very long texts, fall back to simple "show original deleted + modified inserted"
  if (m + n > 4000) {
    return [
      { type: 'delete', text: original },
      { type: 'insert', text: modified },
    ];
  }

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff segments
  const segments: DiffSegment[] = [];
  let i = m;
  let j = n;
  const stack: DiffSegment[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push({ type: 'equal', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'insert', text: b[j - 1] });
      j--;
    } else {
      stack.push({ type: 'delete', text: a[i - 1] });
      i--;
    }
  }

  // Reverse and merge consecutive same-type segments
  stack.reverse();
  for (const seg of stack) {
    const last = segments[segments.length - 1];
    if (last && last.type === seg.type) {
      last.text += seg.text;
    } else {
      segments.push({ ...seg });
    }
  }

  return segments;
}

const DiffViewer: React.FC<DiffViewerProps> = ({
  original,
  modified,
  onAccept,
  onReject,
  title,
  acceptText,
  rejectText,
}) => {
  const segments = useMemo(() => computeDiff(original, modified), [original, modified]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-neutral-800 border border-neutral-600 rounded-lg shadow-2xl w-[720px] max-w-[90vw] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <h3 className="text-sm font-medium text-neutral-200">{title ?? 'AI 改写预览'}</h3>
          <button
            type="button"
            onClick={onReject}
            className="text-neutral-400 hover:text-neutral-200 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Diff body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-neutral-300">
          {segments.map((seg, idx) => {
            if (seg.type === 'equal') {
              return <span key={idx}>{seg.text}</span>;
            }
            if (seg.type === 'delete') {
              return (
                <span
                  key={idx}
                  className="bg-red-900/40 text-red-300 line-through rounded px-0.5"
                >
                  {seg.text}
                </span>
              );
            }
            // insert
            return (
              <span
                key={idx}
                className="bg-green-900/40 text-green-300 rounded px-0.5"
              >
                {seg.text}
              </span>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-700">
          <button
            type="button"
            onClick={onReject}
            className="px-4 py-1.5 rounded text-sm font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 transition-colors"
          >
            {rejectText ?? '拒绝'}
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="px-4 py-1.5 rounded text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            {acceptText ?? '接受'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DiffViewer;
