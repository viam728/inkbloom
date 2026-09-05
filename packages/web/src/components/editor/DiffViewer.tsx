import React, { useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface DiffViewerProps {
  original: string;
  modified: string;
  onAccept: () => void;
  onReject: () => void;
  /**
   * 以下三项为可选文案覆盖。缺省时保持 AI 改写场景的原文案，版本对比
   * 复用本组件时传入自己的措辞。
   */
  title?: string;
  acceptText?: string;
  rejectText?: string;
  /** 只读对比：隐藏接受按钮（发布版 vs 编辑版预览用，无回滚/接受语义） */
  hideAccept?: boolean;
  /**
   * 遮罩层级类名。组件固定 portal 到 body 并默认 z-[1300]（高于发布弹窗
   * z-[1000] 等一切面板）——「对比被窗口遮住」的根治：不依赖宿主层级。
   */
  overlayClass?: string;
  /** 左侧窗格标签（VSCode 式文件头），如「发布版」 */
  leftLabel?: string;
  /** 右侧窗格标签，如「编辑版（草稿）」 */
  rightLabel?: string;
}

// ── 行级 diff（LCS）＋ 行内 token 级高亮 ────────────────────────────────
// 完全对照 VSCode diff 编辑器：
//   · 左右双栏、各自行号、逐行严格对齐（同一网格行）
//   · 变更块（删+增）配对成「修改行」，行内再按 token 做二级高亮
//   · 删除行红底 / 新增行绿底 / 被挖空的补位行灰底（VSCode void 样式）
//   · 单一滚动容器天然同步滚动（VSCode 同步滚动行为）

interface DiffToken {
  text: string;
  changed: boolean;
}

interface DiffLine {
  num: number | null; // 原文行号（左）/ 新文行号（右）；null = 补位行
  tokens: DiffToken[];
}

interface DiffRow {
  kind: 'equal' | 'modified' | 'delete' | 'insert';
  left: DiffLine | null;
  right: DiffLine | null;
}

const TOKEN_LIMIT = 3000; // 行内 token diff 的字符上限，超出退化为整行高亮

/** 行内二级 diff：公共前缀/后缀裁剪后高亮中段（VSCode word-diff 的近似） */
function tokenDiff(a: string, b: string): { at: DiffToken[]; bt: DiffToken[] } {
  if (a === b) {
    return { at: [{ text: a, changed: false }], bt: [{ text: b, changed: false }] };
  }
  if (a.length + b.length > TOKEN_LIMIT) {
    return {
      at: [{ text: a, changed: true }],
      bt: [{ text: b, changed: true }],
    };
  }
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix = a.slice(0, start);
  const suffix = a.slice(endA);
  const midB = b.slice(start, endB);
  return {
    at: [
      ...(prefix ? [{ text: prefix, changed: false }] : []),
      { text: a.slice(start, endA), changed: true },
      ...(suffix ? [{ text: suffix, changed: false }] : []),
    ],
    bt: [
      ...(prefix ? [{ text: prefix, changed: false }] : []),
      { text: midB, changed: true },
      ...(suffix ? [{ text: suffix, changed: false }] : []),
    ],
  };
}

/** 行级 LCS → VSCode 式对齐行序列 */
function computeRows(original: string, modified: string): DiffRow[] {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = modified.replace(/\r\n/g, '\n').split('\n');
  const m = a.length;
  const n = b.length;

  // 超长文本保护：全量 LCS DP 是 O(m*n)，章节级文本（数千行内）可承受，
  // 超限则退化为整块替换。
  if (m * n > 4_000_000) {
    const rows: DiffRow[] = [];
    for (let i = 0; i < m; i++) rows.push({ kind: 'delete', left: { num: i + 1, tokens: [{ text: a[i], changed: false }] }, right: null });
    for (let j = 0; j < n; j++) rows.push({ kind: 'insert', left: null, right: { num: j + 1, tokens: [{ text: b[j], changed: false }] } });
    return rows;
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯产出 op 序列，再把连续 delete+insert 合并成 modified（配对）块。
  type Op = { t: 'eq' | 'del' | 'ins'; i: number; j: number };
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ t: 'eq', i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ t: 'ins', i, j: j - 1 });
      j--;
    } else {
      ops.push({ t: 'del', i: i - 1, j });
      i--;
    }
  }
  ops.reverse();

  const rows: DiffRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.t === 'eq') {
      rows.push({
        kind: 'equal',
        left: { num: op.i + 1, tokens: [{ text: a[op.i], changed: false }] },
        right: { num: op.j + 1, tokens: [{ text: b[op.j], changed: false }] },
      });
      k++;
      continue;
    }
    // 收集连续的 del/ins run
    const dels: string[] = [];
    const ins: string[] = [];
    while (k < ops.length && ops[k].t !== 'eq') {
      if (ops[k].t === 'del') dels.push(a[ops[k].i]);
      else ins.push(b[ops[k].j]);
      k++;
    }
    const maxPairs = Math.max(dels.length, ins.length);
    for (let p = 0; p < maxPairs; p++) {
      const dl = p < dels.length ? dels[p] : null;
      const rl = p < ins.length ? ins[p] : null;
      if (dl != null && rl != null) {
        const { at, bt } = tokenDiff(dl, rl);
        rows.push({
          kind: 'modified',
          left: { num: null, tokens: at },
          right: { num: null, tokens: bt },
        });
      } else if (dl != null) {
        rows.push({ kind: 'delete', left: { num: null, tokens: [{ text: dl, changed: false }] }, right: null });
      } else {
        rows.push({ kind: 'insert', left: null, right: { num: null, tokens: [{ text: rl as string, changed: false }] } });
      }
    }
  }

  // 回填真实行号：delete/insert/modified 行的行号在回溯时丢失，这里重扫。
  let ln = 0;
  let rn = 0;
  for (const row of rows) {
    if (row.left) row.left.num = ++ln;
    if (row.right) row.right.num = ++rn;
  }
  // 补位行（一侧为 null）不占行号——已在上面按存在性编号。
  return rows;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function LineContent({ tokens }: { tokens: DiffToken[] }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.changed ? (
          <span key={i} className="diff-word-changed">{t.text}</span>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}

/**
 * VSCode 风格左右分屏对比：
 * 左 = original（发布版），右 = modified（编辑版），单一滚动容器同步滚动。
 */
const DiffViewer: React.FC<DiffViewerProps> = ({
  original,
  modified,
  onAccept,
  onReject,
  title,
  acceptText,
  rejectText,
  hideAccept = false,
  overlayClass = 'z-[1300]',
  leftLabel = '发布版',
  rightLabel = '编辑版（草稿）',
}) => {
  const rows = useMemo(() => computeRows(original, modified), [original, modified]);

  // 统计变更规模（VSCode 底部「x changes」徽标）
  const changes = useMemo(
    () => rows.filter((r) => r.kind !== 'equal').length,
    [rows],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onReject();
    },
    [onReject],
  );

  return createPortal(
    <div
      className={`fixed inset-0 ${overlayClass} flex items-center justify-center bg-black/65 backdrop-blur-[2px]`}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-col w-[94vw] max-w-[1400px] h-[88vh] bg-[#1e1e1e] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
        {/* VSCode 式标题栏 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8 bg-[#252526] shrink-0">
          <span className="text-sm font-medium text-neutral-100 truncate">{title ?? '版本对比'}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25 tabular-nums">
            {changes} 处变更
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onReject}
            title="关闭 (Esc)"
            className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-white/8 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 双侧文件头（VSCode diff editor 标签行） */}
        <div className="grid grid-cols-2 border-b border-white/8 bg-[#2d2d2d] shrink-0">
          <div className="flex items-center gap-2 px-4 py-1.5 border-r border-white/8">
            <span className="text-[11px] text-neutral-400 truncate">{leftLabel}</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5">
            <span className="text-[11px] text-neutral-400 truncate">{rightLabel}</span>
          </div>
        </div>

        {/* 对比主体：单一滚动容器 → 天然同步滚动 */}
        <div className="flex-1 overflow-auto bg-[#1e1e1e]">
          <div className="min-w-full">
            {rows.map((row, idx) => {
              const leftVoid = row.left === null;
              const rightVoid = row.right === null;
              const leftBg =
                row.kind === 'delete' || row.kind === 'modified'
                  ? 'bg-[#3a1d1d]'
                  : leftVoid
                    ? 'bg-[#242424]'
                    : '';
              const rightBg =
                row.kind === 'insert' || row.kind === 'modified'
                  ? 'bg-[#1d2a1d]'
                  : rightVoid
                    ? 'bg-[#242424]'
                    : '';
              return (
                <div key={idx} className="grid grid-cols-[64px_1fr_64px_1fr] leading-[1.55]">
                  {/* 左：行号 + 原文 */}
                  <div
                    className={`diff-gutter select-none text-right pr-2 pl-3 text-[11px] tabular-nums text-neutral-500 border-r border-white/5 ${leftBg}`}
                  >
                    {row.left?.num ?? ''}
                  </div>
                  <div
                    className={`diff-line px-3 whitespace-pre-wrap break-words text-[13px] text-neutral-300 border-r border-white/5 ${leftBg}`}
                  >
                    {!leftVoid && row.left && <LineContent tokens={row.left.tokens} />}
                  </div>
                  {/* 右：行号 + 新文 */}
                  <div
                    className={`diff-gutter select-none text-right pr-2 pl-3 text-[11px] tabular-nums text-neutral-500 border-r border-white/5 ${rightBg}`}
                  >
                    {row.right?.num ?? ''}
                  </div>
                  <div
                    className={`diff-line px-3 whitespace-pre-wrap break-words text-[13px] text-neutral-300 ${rightBg}`}
                  >
                    {!rightVoid && row.right && <LineContent tokens={row.right.tokens} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 底部操作条（VSCode 面板式） */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/8 bg-[#252526] shrink-0">
          <span className="text-[11px] text-neutral-500">← 原文 · 修改后 →</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onReject}
            className="px-4 py-1.5 rounded-md text-sm font-medium text-neutral-300 bg-white/6 hover:bg-white/12 border border-white/8 transition-colors"
          >
            {rejectText ?? (hideAccept ? '关闭' : '拒绝')}
          </button>
          {!hideAccept && (
            <button
              type="button"
              onClick={onAccept}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-600/25"
            >
              {acceptText ?? '接受'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default DiffViewer;

