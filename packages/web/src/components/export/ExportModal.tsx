import React, { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Copy, Download, Wand2, Loader2, Check, ExternalLink } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { FORMAT_OPTIONS } from '@/types/format';
import { convertFormat, exportChapter, exportNovel } from '@/services/format-client';
import { useNovelStore } from '@/stores/novel-store';
import { useMediaStore } from '@/stores/media-store';
import { useMemoStore } from '@/stores/memo-store';
import { useToast } from '@/components/common/Toast';
import { PLATFORMS, type MediaPlatform } from '@/types/media';
import type { EditorVariant } from '@/components/editor/TipTapEditor';

/** 小说模式：外部创作平台快链（原状态栏平铺入口，收纳进弹窗） */
const PLATFORM_LINKS: { name: string; url: string; description: string }[] = [
  { name: '微信公众号', url: 'https://mp.weixin.qq.com/', description: '公众号后台' },
  { name: '知乎创作者中心', url: 'https://zhuanlan.zhihu.com/write', description: '知乎写作' },
  { name: '今日头条', url: 'https://mp.toutiao.com/profile_v4/graphic/publish', description: '头条号发布' },
  { name: '起点作家中心', url: 'https://author.qidian.com/', description: '起点中文网' },
];

const extOf = (formatId: string) =>
  formatId === 'markdown' ? '.md' : formatId === 'qidian' ? '.txt' : '.html';

const sectionLabel = 'text-[10px] uppercase tracking-wider text-neutral-600 mb-1.5';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  editor: Editor | null;
  variant: EditorVariant;
  /** 自媒体模式：当前发布平台与选择回调 */
  platform?: MediaPlatform;
  onSelectPlatform?: (id: MediaPlatform) => void;
  /** 自媒体模式：平台风格改写（成功 resolve 后自动关闭弹窗，失败请 reject） */
  onAdapt?: () => Promise<void>;
}

/**
 * 统一"导出"弹窗：合并原工具栏复制按钮、导出弹窗与平台快链/平台选择器。
 * - 小说模式：章节/整本范围 + 格式导出、复制、平台快链
 * - 自媒体模式：目标平台选择、复制、本地导出、平台适配
 * - 随记模式：复制、本地导出
 */
const ExportModal: React.FC<ExportModalProps> = ({
  open,
  onClose,
  editor,
  variant,
  platform,
  onSelectPlatform,
  onAdapt,
}) => {
  const isNovel = variant === 'novel';
  const isMedia = variant === 'media';

  const currentChapter = useNovelStore((s) => s.currentChapter);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const mediaContent = useMediaStore((s) => s.currentContent);
  const memoNotes = useMemoStore((s) => s.notes);
  const memoCurrentId = useMemoStore((s) => s.currentId);
  const currentMemo = memoNotes.find((n) => n.id === memoCurrentId) ?? null;

  const { showToast } = useToast();
  const [scope, setScope] = useState<'chapter' | 'novel'>('chapter');
  const [busy, setBusy] = useState<string | null>(null);

  const currentPlatform = PLATFORMS.find((p) => p.id === platform);

  /** 复制选项：小说模式沿用原复制菜单格式；其余模式提供纯文本/Markdown/HTML */
  const copyOptions: { id: string; name: string }[] = [
    ...(isNovel
      ? FORMAT_OPTIONS.filter((f) => ['wechat', 'zhihu', 'markdown', 'html'].includes(f.id)).map(
          (f) => ({ id: f.id, name: f.name }),
        )
      : [
          { id: 'plain', name: '纯文本' },
          ...FORMAT_OPTIONS.filter((f) => ['markdown', 'html'].includes(f.id)).map((f) => ({
            id: f.id,
            name: f.name,
          })),
        ]),
  ];

  /** 文件导出选项：小说走服务端导出（全部格式）；其余模式本地转换下载 */
  const exportOptions = isNovel
    ? FORMAT_OPTIONS
    : FORMAT_OPTIONS.filter((f) => ['markdown', 'html', 'qidian'].includes(f.id));

  const baseFilename = (): string => {
    if (isNovel) {
      return scope === 'chapter'
        ? currentChapter?.title ?? '章节'
        : currentNovel?.title ?? '小说';
    }
    if (isMedia) return mediaContent?.title || '自媒体内容';
    return currentMemo?.title || '随记';
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 复制到剪贴板（等价迁移原 CopyMenu 逻辑，内容取自当前编辑器） */
  const handleCopy = async (formatId: string) => {
    if (!editor || editor.isEmpty) {
      showToast('没有可复制的内容', 'error');
      return;
    }
    setBusy(`copy:${formatId}`);
    try {
      if (formatId === 'plain') {
        await navigator.clipboard.writeText(editor.getText());
        showToast('已复制为 纯文本', 'success');
        onClose();
        return;
      }
      const converted = await convertFormat(editor.getJSON(), formatId);
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
      onClose();
    } catch (e) {
      console.error('Copy failed', e);
      showToast('复制失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 导出为文件：小说模式沿用服务端 /export 链路，其余模式本地格式转换下载 */
  const handleExport = async (formatId: string) => {
    setBusy(`export:${formatId}`);
    try {
      let blob: Blob;
      let filename = baseFilename();

      if (isNovel) {
        if (scope === 'chapter' && currentChapter) {
          blob = await exportChapter(currentChapter.id, formatId);
        } else if (scope === 'novel' && currentNovel) {
          blob = await exportNovel(currentNovel.id, formatId);
        } else {
          showToast('请先选择章节或小说', 'error');
          return;
        }
        if (scope === 'novel') filename += '.zip';
        else filename += extOf(formatId);
      } else {
        if (!editor || editor.isEmpty) {
          showToast('没有可导出的内容', 'error');
          return;
        }
        const converted = await convertFormat(editor.getJSON(), formatId);
        const format = FORMAT_OPTIONS.find((f) => f.id === formatId);
        blob = new Blob([converted], { type: format?.mimeType ?? 'text/plain' });
        filename += extOf(formatId);
      }

      downloadBlob(blob, filename);
      const format = FORMAT_OPTIONS.find((f) => f.id === formatId);
      showToast(`导出 ${format?.name ?? formatId} 成功`, 'success');
      onClose();
    } catch (e) {
      console.error('Export failed', e);
      showToast('导出失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 平台适配：改写成功后关闭弹窗（失败由调用方 toast 并 reject） */
  const handleAdapt = async () => {
    if (!onAdapt) return;
    setBusy('adapt');
    try {
      await onAdapt();
      onClose();
    } catch {
      // 失败提示已由调用方处理
    } finally {
      setBusy(null);
    }
  };

  const chipCls =
    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ' +
    'text-neutral-300 bg-white/4 hover:bg-white/8 hover:text-neutral-100 disabled:opacity-40';

  return (
    <Modal open={open} onClose={onClose} title="导出" width="480px">
      <div className="p-4 space-y-5">
        {/* 目标平台选择（仅自媒体模式） */}
        {isMedia && (
          <section>
            <p className={sectionLabel}>目标平台</p>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORMS.map((p) => {
                const selected = platform === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectPlatform?.(p.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs transition-all ${
                      selected
                        ? 'bg-brand-600/20 text-brand-200 shadow-[0_0_0_1px_rgba(99,102,241,0.35)]'
                        : 'bg-white/4 text-neutral-300 hover:bg-white/8'
                    }`}
                  >
                    <span className="text-sm shrink-0">{p.emoji}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium">{p.label}</span>
                      <span className="block text-[10px] text-neutral-500 truncate">
                        建议 ≤ {p.maxWords} 字
                      </span>
                    </span>
                    {selected && <Check size={12} className="text-brand-300 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* 导出范围（仅小说模式） */}
        {isNovel && (
          <section>
            <p className={sectionLabel}>导出范围</p>
            <div className="flex gap-2">
              <button
                type="button"
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  scope === 'chapter'
                    ? 'bg-brand-600 text-white'
                    : 'bg-white/4 text-neutral-300 hover:bg-white/8'
                }`}
                onClick={() => setScope('chapter')}
                disabled={!currentChapter}
              >
                当前章节
              </button>
              <button
                type="button"
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  scope === 'novel'
                    ? 'bg-brand-600 text-white'
                    : 'bg-white/4 text-neutral-300 hover:bg-white/8'
                }`}
                onClick={() => setScope('novel')}
                disabled={!currentNovel}
              >
                整本小说
              </button>
            </div>
          </section>
        )}

        {/* 复制到剪贴板 */}
        <section>
          <p className={sectionLabel}>复制到剪贴板</p>
          <div className="flex flex-wrap gap-2">
            {copyOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={busy !== null}
                onClick={() => handleCopy(opt.id)}
                className={chipCls}
              >
                {busy === `copy:${opt.id}` ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Copy size={12} />
                )}
                {opt.name}
              </button>
            ))}
          </div>
        </section>

        {/* 导出为文件 */}
        <section>
          <p className={sectionLabel}>导出为文件</p>
          <div className="flex flex-col gap-1.5">
            {exportOptions.map((fmt) => (
              <button
                key={fmt.id}
                type="button"
                disabled={busy !== null}
                onClick={() => handleExport(fmt.id)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/4 hover:bg-white/8 transition-colors text-left disabled:opacity-50"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-neutral-100">{fmt.name}</div>
                  <div className="text-[10px] text-neutral-500 truncate">{fmt.description}</div>
                </div>
                <span className="shrink-0 flex items-center gap-1 text-[11px] text-neutral-500">
                  {busy === `export:${fmt.id}` ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> 导出中…
                    </>
                  ) : (
                    <>
                      <Download size={11} /> 导出
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* 平台适配（仅自媒体模式；顶栏独立入口保留，此处为弹窗内收纳入口） */}
        {isMedia && onAdapt && (
          <section>
            <button
              type="button"
              disabled={busy !== null || !editor || editor.isEmpty}
              onClick={handleAdapt}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-gradient-to-r from-pink-600/80 to-indigo-600/80 hover:from-pink-500 hover:to-indigo-500 text-white disabled:opacity-40 transition-all"
            >
              {busy === 'adapt' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Wand2 size={13} />
              )}
              按「{currentPlatform?.label ?? '当前平台'}」风格改写全文
            </button>
          </section>
        )}

        {/* 平台快链（仅小说模式，外部链接收纳） */}
        {isNovel && (
          <section>
            <p className={sectionLabel}>平台快链</p>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORM_LINKS.map((link) => (
                <a
                  key={link.name}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-brand-300 hover:bg-white/6 transition-colors"
                  title={`${link.name} - ${link.description}`}
                >
                  <ExternalLink size={10} />
                  {link.name}
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
};

export default ExportModal;
