import React, { useState, useEffect, useCallback } from 'react';
import {
  Wand2,
  Sparkles,
  Loader2,
  Download,
  Trash2,
  Image as ImageIcon,
  Zap,
  Cpu,
} from 'lucide-react';
import { useAIGCStore } from '@/stores/aigc-store';
import { useNovelStore } from '@/stores/novel-store';
import { generateImagePromptFromChapter, type ImagePromptResult } from '@/services/prompt-client';
import { useToast } from '@/components/common/Toast';
import ImagePreview from './ImagePreview';
import PromptEditor from './PromptEditor';

/** 比例可视化选择项 */
const RATIO_OPTIONS = [
  { label: '1:1', desc: '1024×1024', width: 1024, height: 1024, box: 'w-5 h-5' },
  { label: '9:16', desc: '1024×1792', width: 1024, height: 1792, box: 'w-3.5 h-5' },
  { label: '16:9', desc: '1792×1024', width: 1792, height: 1024, box: 'w-5 h-3.5' },
  { label: '草稿', desc: '512×512', width: 512, height: 512, box: 'w-4 h-4' },
];

const PROVIDER_OPTIONS = [
  { label: 'Pollinations', tag: '免费', value: 'pollinations', icon: Zap },
  { label: 'DALL-E', tag: 'OpenAI', value: 'dalle', icon: Cpu },
];

const AIGCPanel: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [ratioIdx, setRatioIdx] = useState(0);
  const [provider, setProvider] = useState('pollinations');
  const [previewAsset, setPreviewAsset] = useState<{ src: string; prompt: string } | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  // Auto-prefab state
  const [autoStyle, setAutoStyle] = useState('realistic');
  const [promptResult, setPromptResult] = useState<ImagePromptResult | null>(null);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  const { showToast } = useToast();
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const { tasks, assets, generating, createImageTask, fetchAssets, deleteAsset } =
    useAIGCStore();

  useEffect(() => {
    if (currentNovel) {
      fetchAssets(currentNovel.id);
    }
  }, [currentNovel?.id, fetchAssets]);

  const handleGenerate = useCallback(async () => {
    const text = prompt.trim();
    if (!text || generating) return;

    const ratio = RATIO_OPTIONS[ratioIdx];
    try {
      await createImageTask(text, {
        width: ratio.width,
        height: ratio.height,
        provider,
        novel_id: currentNovel?.id,
        chapter_id: currentChapter?.id,
      });
      setPrompt('');
    } catch {
      showToast('图片任务创建失败，请检查后端服务', 'error');
    }
  }, [prompt, generating, ratioIdx, provider, currentNovel, currentChapter, createImageTask, showToast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleAutoPrefab = async (style?: string) => {
    if (!currentNovel || !currentChapter) return;
    setIsPrefetching(true);
    try {
      const result = await generateImagePromptFromChapter(
        currentNovel.id,
        currentChapter.id,
        style ?? autoStyle,
      );
      setPromptResult(result);
      setShowEditor(true);
    } catch {
      showToast('Prompt 生成失败，请重试', 'error');
    } finally {
      setIsPrefetching(false);
    }
  };

  const handleEditorConfirm = (confirmedPrompt: string, _negativePrompt: string) => {
    setPrompt(confirmedPrompt);
    setShowEditor(false);
    setPromptResult(null);
  };

  const handleEditorRegenerate = (style: string) => {
    setAutoStyle(style);
    handleAutoPrefab(style);
  };

  const handleEditorCancel = () => {
    setShowEditor(false);
    setPromptResult(null);
  };

  const handleDownload = async (src: string, id: number) => {
    setDownloadingId(id);
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inkbloom-${id}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('图片已下载', 'success');
    } catch {
      showToast('下载失败', 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  const activeTasks = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'running',
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/6">
        <span className="w-6 h-6 rounded-lg bg-gradient-to-br from-brand-500/30 to-fuchsia-500/30 flex items-center justify-center">
          <ImageIcon size={13} className="text-brand-300" />
        </span>
        <span className="text-sm font-medium text-neutral-200">AI 图片生成</span>
        {currentNovel && (
          <span className="ml-auto text-[10px] text-neutral-500 truncate max-w-[110px]">
            {currentNovel.title}
          </span>
        )}
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {/* Prompt input */}
        <div className="px-3.5 py-3 space-y-3 border-b border-white/6">
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述你想生成的画面，如：雨夜霓虹下的少女回眸，赛博朋克风格…"
              rows={3}
              className="w-full bg-surface-2 text-neutral-200 text-sm rounded-xl px-3 py-2.5 pr-14 border border-white/8 outline-none focus:border-brand-500/50 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.12)] resize-none placeholder-neutral-600 transition-all"
            />
            {prompt.length > 0 && (
              <span className="absolute bottom-2 right-2.5 text-[10px] text-neutral-600">
                {prompt.length}
              </span>
            )}
          </div>

          {/* Ratio selector */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5">
              画幅比例
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {RATIO_OPTIONS.map((opt, i) => {
                const selected = i === ratioIdx;
                return (
                  <button
                    key={opt.label}
                    onClick={() => setRatioIdx(i)}
                    title={opt.desc}
                    className={`flex flex-col items-center gap-1 py-2 rounded-lg border transition-all ${
                      selected
                        ? 'border-brand-500/50 bg-brand-600/15 text-brand-300'
                        : 'border-white/6 bg-surface-2 text-neutral-400 hover:bg-white/4 hover:text-neutral-300'
                    }`}
                  >
                    <span
                      className={`${opt.box} rounded-[3px] border ${
                        selected ? 'border-brand-400' : 'border-neutral-500'
                      }`}
                    />
                    <span className="text-[10px] leading-none">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Provider selector */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5">
              生成引擎
            </p>
            <div className="flex gap-1.5">
              {PROVIDER_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = provider === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setProvider(opt.value)}
                    className={`flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all ${
                      selected
                        ? 'border-brand-500/50 bg-brand-600/15 text-brand-300'
                        : 'border-white/6 bg-surface-2 text-neutral-400 hover:bg-white/4 hover:text-neutral-300'
                    }`}
                  >
                    <Icon size={12} className="shrink-0" />
                    <span>{opt.label}</span>
                    <span
                      className={`ml-auto text-[9px] rounded-full px-1.5 py-0.5 ${
                        selected ? 'bg-brand-500/20 text-brand-300' : 'bg-white/5 text-neutral-500'
                      }`}
                    >
                      {opt.tag}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || generating}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:from-surface-3 disabled:to-surface-3 disabled:text-neutral-600 text-white text-sm font-medium rounded-xl px-3 py-2.5 transition-all shadow-[0_4px_16px_rgba(99,102,241,0.25)] disabled:shadow-none"
          >
            {generating ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                生成图片
              </>
            )}
          </button>

          {/* Auto-prefab — only when a novel+chapter is selected */}
          {currentNovel && currentChapter && (
            <button
              onClick={() => handleAutoPrefab()}
              disabled={isPrefetching || generating}
              className="w-full flex items-center justify-center gap-2 bg-transparent border border-fuchsia-500/30 hover:border-fuchsia-400/60 hover:bg-fuchsia-500/10 disabled:opacity-40 text-fuchsia-300 text-xs rounded-xl px-3 py-2 transition-all"
            >
              {isPrefetching ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  正在分析章节内容…
                </>
              ) : (
                <>
                  <Wand2 size={13} />
                  根据当前章节自动生成 Prompt
                </>
              )}
            </button>
          )}

          {/* Prompt editor */}
          {showEditor && (
            <PromptEditor
              result={promptResult}
              style={autoStyle}
              loading={isPrefetching}
              onConfirm={handleEditorConfirm}
              onRegenerate={handleEditorRegenerate}
              onStyleChange={setAutoStyle}
              onCancel={handleEditorCancel}
            />
          )}
        </div>

        {/* Active tasks */}
        {activeTasks.length > 0 && (
          <div className="px-3.5 py-2.5 border-b border-white/6 space-y-2">
            {activeTasks.map((t) => (
              <div key={t.id} className="rounded-xl bg-surface-2 border border-white/6 px-3 py-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <Loader2 size={12} className="shrink-0 text-brand-400 animate-spin" />
                  <span className="text-xs text-neutral-300 truncate flex-1">{t.prompt}</span>
                  <span className="text-[10px] text-brand-300 shrink-0">{t.progress}%</span>
                </div>
                <div className="h-1 rounded-full bg-white/6 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-brand-500 to-fuchsia-500 transition-all duration-500"
                    style={{ width: `${Math.max(t.progress, 4)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Asset gallery */}
        <div className="px-3.5 py-3.5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              生成记录
            </p>
            {assets.length > 0 && (
              <span className="text-[10px] text-neutral-600">{assets.length} 张</span>
            )}
          </div>

          {assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500/20 to-fuchsia-500/20 flex items-center justify-center mb-3">
                <ImageIcon size={22} className="text-brand-400/70" />
              </div>
              <p className="text-sm text-neutral-400 mb-1">还没有作品</p>
              <p className="text-[11px] text-neutral-600 leading-relaxed">
                输入描述或使用「自动生成 Prompt」
                <br />
                为你的文章创作配图
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="group relative rounded-xl overflow-hidden border border-white/6 hover:border-brand-500/50 transition-all cursor-pointer bg-surface-2 hover:shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                  onClick={() => setPreviewAsset({ src: asset.file_path, prompt: asset.prompt })}
                >
                  <img
                    src={asset.thumbnail_path || asset.file_path}
                    alt={asset.prompt}
                    className="w-full aspect-square object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                    loading="lazy"
                  />
                  {/* size badge */}
                  <span className="absolute top-1.5 left-1.5 text-[9px] px-1.5 py-0.5 rounded-md bg-black/50 backdrop-blur text-neutral-300 opacity-0 group-hover:opacity-100 transition-opacity">
                    {asset.width}×{asset.height}
                  </span>
                  {/* hover overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2">
                    <p className="text-[10px] text-white/90 line-clamp-2 mb-1.5">{asset.prompt}</p>
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(asset.file_path, asset.id);
                        }}
                        className="flex-1 flex items-center justify-center gap-1 h-6 rounded-md bg-white/15 hover:bg-white/25 text-white text-[10px] backdrop-blur transition-colors"
                        title="下载"
                      >
                        {downloadingId === asset.id ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Download size={10} />
                        )}
                        下载
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAsset(asset.id);
                          showToast('已删除', 'info');
                        }}
                        className="w-6 h-6 rounded-md bg-white/15 hover:bg-red-500/60 text-white backdrop-blur flex items-center justify-center transition-colors"
                        title="删除"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Image Preview Modal */}
      {previewAsset && (
        <ImagePreview
          src={previewAsset.src}
          prompt={previewAsset.prompt}
          onDownload={() => handleDownload(previewAsset.src, 0)}
          onClose={() => setPreviewAsset(null)}
        />
      )}
    </div>
  );
};

export default AIGCPanel;
