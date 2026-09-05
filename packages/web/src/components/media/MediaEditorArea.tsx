import React, { useEffect, useRef, useState } from 'react';
import {
  Megaphone,
  Wand2,
  Loader2,
  Check,
  CircleDashed,
} from 'lucide-react';
import { useMediaStore } from '@/stores/media-store';
import { useUIStore } from '@/stores/ui-store';
import { useToast } from '@/components/common/Toast';
import { PLATFORMS, type MediaPlatform } from '@/types/media';
import { adaptContent } from '@/services/media-client';
import TipTapEditor from '@/components/editor/TipTapEditor';
import AigcCard from '@/components/ai/AigcCard';

// ── 纯文本 → HTML 辅助（平台适配改写结果转回富文本） ────────────────
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plainToHtml = (text: string) =>
  text
    .split(/\n/)
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p></p>'))
    .join('');

/** 阅读耗时预估：中文平均约 400 字/分钟 */
const estimateReadMinutes = (words: number) => (words <= 0 ? 0 : Math.max(1, Math.round(words / 400)));

type SaveStatus = 'saved' | 'dirty' | 'saving';
/** 自媒体模式编辑区：标题 + 富文本正文 + 平台适配（平台选择/复制/导出已收纳进统一导出弹窗） */
const MediaEditorArea: React.FC = () => {
  const { currentContent, saveContent } = useMediaStore();
  const focusMode = useUIStore((s) => s.focusMode);
  const { showToast } = useToast();

  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState<MediaPlatform>('wechat');
  const [content, setContent] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [adapting, setAdapting] = useState(false);

  // ── 保存状态机：saved（已保存）/ dirty（有待保存改动）/ saving（保存中） ──
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ title?: string; content?: string; platform?: MediaPlatform } | null>(null);
  const contentIdRef = useRef<number | null>(null);

  // 切换内容时同步本地状态
  useEffect(() => {
    setTitle(currentContent?.title ?? '');
    setPlatform(currentContent?.platform ?? 'wechat');
    setContent(currentContent?.content ?? '');
    setWordCount(0);
    setSaveStatus('saved');
    pendingRef.current = null;
    contentIdRef.current = currentContent?.id ?? null;
  }, [currentContent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentMeta = PLATFORMS.find((p) => p.id === platform);
  const overLimit = currentMeta ? wordCount > currentMeta.maxWords : false;
  const isEmpty = !content.trim() || content === '<p></p>';
  const readMinutes = estimateReadMinutes(wordCount);

  /** 立即落盘当前待保存改动（手动点击状态图标 / 防抖到期时调用） */
  const flushSave = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const id = contentIdRef.current;
    const patch = pendingRef.current;
    if (!id || !patch) return;
    pendingRef.current = null;
    setSaveStatus('saving');
    try {
      await saveContent(id, patch);
      setSaveStatus('saved');
    } catch {
      // 保存失败，改动仍在待保存队列，可再次手动点击重试
      pendingRef.current = patch;
      setSaveStatus('dirty');
      showToast('保存失败，点击状态图标可重试', 'error');
    }
  };

  const scheduleSave = (next: { title?: string; content?: string; platform?: MediaPlatform }) => {
    if (!currentContent) return;
    pendingRef.current = { ...(pendingRef.current ?? {}), ...next };
    setSaveStatus('dirty');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      flushSave();
    }, 800);
  };

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  /** 手动点击保存状态图标：有待保存改动立即保存；已保存则提示 */
  const handleStatusClick = () => {
    if (saveStatus === 'saving') return;
    if (saveStatus === 'dirty' || pendingRef.current) {
      flushSave();
    } else {
      showToast('内容已是最新，无需保存', 'info');
    }
  };

  const handleSelectPlatform = (id: MediaPlatform) => {
    setPlatform(id);
    scheduleSave({ platform: id });
  };

  const handleAdapt = async () => {
    if (!currentContent || isEmpty) return;
    setAdapting(true);
    try {
      const adapted = await adaptContent(content, platform);
      const html = plainToHtml(adapted);
      setContent(html);
      scheduleSave({ content: html });
      showToast(`已适配「${currentMeta?.label ?? platform}」风格`, 'success');
    } catch {
      showToast('平台适配失败', 'error');
      throw new Error('adapt failed');
    } finally {
      setAdapting(false);
    }
  };

  // 富文本内容变化 → 防抖保存
  const handleContentChange = (html: string) => {
    setContent(html);
    scheduleSave({ content: html });
  };

  /** AIGC 产物 → 纯文本转 HTML 定向插入本编辑器光标处 */
  const insertAigc = (text: string) => {
    const html = plainToHtml(text);
    setContent((prev) => prev);
    window.dispatchEvent(
      new CustomEvent('inkbloom:insert-content', {
        detail: { html, target: `media-content-${currentContent?.id ?? 0}` },
      }),
    );
  };

  if (!currentContent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-0 relative overflow-hidden">
        <div className="absolute top-1/4 left-1/3 w-72 h-72 rounded-full bg-pink-600/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-1/4 right-1/3 w-72 h-72 rounded-full bg-indigo-600/10 blur-[100px] pointer-events-none" />
        <div className="text-center animate-fade-in-slow relative">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-500/20 to-indigo-500/20 border border-white/8 flex items-center justify-center mb-5">
            <Megaphone size={28} className="text-pink-300" />
          </div>
          <h2 className="text-xl font-semibold mb-2 text-neutral-200">自媒体创作</h2>
          <p className="text-xs text-neutral-500">在左侧内容库中选择或创建一篇内容开始写作</p>
        </div>
      </div>
    );
  }

  const statusIcon =
    saveStatus === 'saving' ? (
      <Loader2 size={12} className="animate-spin" />
    ) : saveStatus === 'dirty' ? (
      <CircleDashed size={12} />
    ) : (
      <Check size={12} />
    );

  const statusLabel =
    saveStatus === 'saving' ? '保存中…' : saveStatus === 'dirty' ? '未保存改动' : '已保存';

  return (
    <div className={`flex-1 flex flex-col min-w-0 bg-surface-0 ${focusMode ? 'focus-mode' : ''}`}>
      {/* 顶栏：标题 + 操作（恒显；专注进出统一由工具栏按钮与 Esc 承担） */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/6 bg-surface-1/60">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave({ title: e.target.value });
          }}
          placeholder="内容标题…"
          className="flex-1 min-w-0 bg-transparent text-sm font-medium text-neutral-200 placeholder-neutral-600 outline-none"
        />
        <button
          onClick={() => handleAdapt().catch(() => {})}
          disabled={adapting || isEmpty}
          title="按当前平台风格改写全文"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-gradient-to-r from-pink-600/80 to-indigo-600/80 hover:from-pink-500 hover:to-indigo-500 text-white disabled:opacity-40 transition-all"
        >
          {adapting ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
          平台适配
        </button>
      </div>

      {/* 正文编辑（复用小说模式的富文本编辑器，平台选择/复制/导出收纳进统一导出弹窗） */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <TipTapEditor
          key={currentContent.id}
          content={content}
          onChange={handleContentChange}
          onWordCount={setWordCount}
          variant="media"
          platform={platform}
          onSelectPlatform={handleSelectPlatform}
          onAdapt={handleAdapt}
          insertTarget={`media-content-${currentContent.id}`}
          aigcSlot={
            /* AIGC 配置卡（备忘录 L61）：基于标题与正文素材生成/扩写内容，插入光标处 */
            <AigcCard
              scene="summary"
              taskLabel="AIGC · 内容创作"
              hint="基于标题与正文生成或扩写内容，插入光标处"
              buildInstruction={(extra) =>
                [
                  title.trim() ? `内容标题：${title.trim()}` : '',
                  isEmpty ? '' : `现有正文摘录：${content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)}`,
                  currentMeta ? `目标平台：${currentMeta.label}（风格：${currentMeta.tone}）` : '',
                  extra ? `附加要求：${extra}` : '请生成适合该平台发布的内容段落。',
                ]
                  .filter(Boolean)
                  .join('\n')
              }
              onApply={insertAigc}
            />
          }
          placeholder={
            currentMeta
              ? `为「${currentMeta.label}」写作（建议 ${currentMeta.maxWords} 字以内）：${currentMeta.tone}`
              : '开始写作…'
          }
        />
      </div>

      {/* 底部状态栏：字数 · 阅读耗时预估 · 平台建议 · 保存状态（可手动点击保存） */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-t border-white/6 bg-surface-1/60 text-xs text-neutral-500">
        <span className="tabular-nums shrink-0">{wordCount} 字</span>
        <span className="w-px h-3 bg-white/8 shrink-0" />
        <span className="tabular-nums shrink-0" title="按 400 字/分钟估算">
          阅读约 {readMinutes === 0 ? '< 1' : readMinutes} 分钟
        </span>
        {currentMeta && (
          <>
            <span className="w-px h-3 bg-white/8 shrink-0" />
            <span className={`truncate ${overLimit ? 'text-amber-400' : 'text-neutral-600'}`}>
              {currentMeta.emoji} {currentMeta.label} · 建议 ≤ {currentMeta.maxWords} 字
              {overLimit && '（已超出）'}
            </span>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={handleStatusClick}
          title={
            saveStatus === 'dirty'
              ? '有待保存改动，点击立即保存'
              : saveStatus === 'saving'
                ? '正在保存…'
                : '内容已保存，点击可重新保存'
          }
          className={`shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-md transition-colors ${
            saveStatus === 'dirty'
              ? 'text-amber-300 hover:bg-amber-500/10'
              : saveStatus === 'saving'
                ? 'text-neutral-400'
                : 'text-emerald-400/80 hover:bg-emerald-500/10'
          }`}
        >
          {statusIcon}
          {statusLabel}
        </button>
      </div>
    </div>
  );
};

export default MediaEditorArea;
