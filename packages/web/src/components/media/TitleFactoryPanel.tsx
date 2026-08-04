import React, { useState } from 'react';
import { Sparkles, Loader2, Copy, Check, Type } from 'lucide-react';
import { useMediaStore } from '@/stores/media-store';
import { useToast } from '@/components/common/Toast';
import { PLATFORMS, type MediaPlatform } from '@/types/media';
import { generateTitles } from '@/services/media-client';

/** 标题工厂：按平台风格批量生成爆款标题候选 */
const TitleFactoryPanel: React.FC = () => {
  const { currentContent, saveContent } = useMediaStore();
  const { showToast } = useToast();

  const [topic, setTopic] = useState('');
  const [platform, setPlatform] = useState<MediaPlatform>(currentContent?.platform ?? 'xiaohongshu');
  const [titles, setTitles] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleGenerate = async () => {
    const seed = topic.trim() || currentContent?.title || '';
    if (!seed) {
      showToast('请先输入选题或为当前内容填写标题', 'error');
      return;
    }
    setGenerating(true);
    setTitles([]);
    try {
      const result = await generateTitles(seed, platform, 8);
      setTitles(result);
    } catch {
      showToast('标题生成失败', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async (title: string, index: number) => {
    try {
      await navigator.clipboard.writeText(title);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      showToast('复制失败', 'error');
    }
  };

  const handleApply = (title: string) => {
    if (!currentContent) {
      showToast('请先在内容库中选择一篇内容', 'error');
      return;
    }
    saveContent(currentContent.id, { title });
    showToast('已应用为当前内容标题', 'success');
  };

  const currentMeta = PLATFORMS.find((p) => p.id === platform);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* 说明 */}
        <div className="px-3 py-2.5 rounded-lg bg-gradient-to-r from-pink-600/10 to-indigo-600/10 border border-white/6">
          <p className="text-[11px] leading-relaxed text-neutral-400">
            输入选题，AI 按所选平台的爆款公式批量生成标题候选，可一键复制或直接应用为内容标题。
          </p>
        </div>

        {/* 选题输入 */}
        <div>
          <label className="block text-[11px] text-neutral-500 mb-1.5">选题 / 核心观点</label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={currentContent?.title ? `默认为当前标题：${currentContent.title}` : '例如：AI 时代普通人的三个逆袭机会'}
            rows={2}
            className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-2 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors resize-none"
          />
        </div>

        {/* 平台选择 */}
        <div>
          <label className="block text-[11px] text-neutral-500 mb-1.5">目标平台</label>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlatform(p.id)}
                className={`px-2 py-1 rounded-md text-[11px] border transition-all ${
                  platform === p.id
                    ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                    : 'text-neutral-500 border-white/8 hover:bg-white/5 hover:text-neutral-300'
                }`}
              >
                {p.emoji} {p.label}
              </button>
            ))}
          </div>
          {currentMeta && (
            <p className="mt-1.5 text-[10px] text-neutral-600">{currentMeta.tone}</p>
          )}
        </div>

        {/* 生成按钮 */}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-gradient-to-r from-pink-600/80 to-indigo-600/80 hover:from-pink-500 hover:to-indigo-500 text-white disabled:opacity-50 transition-all"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? '生成中…' : '生成标题候选'}
        </button>

        {/* 候选列表 */}
        {titles.length > 0 && (
          <div className="space-y-1.5 animate-fade-in">
            {titles.map((title, i) => (
              <div
                key={`${i}-${title}`}
                className="group flex items-start gap-2 px-2.5 py-2 rounded-lg bg-white/4 border border-white/6 hover:border-brand-500/30 transition-colors"
              >
                <span className="shrink-0 w-5 h-5 rounded bg-white/6 text-[10px] text-neutral-500 flex items-center justify-center mt-0.5 tabular-nums">
                  {i + 1}
                </span>
                <p className="flex-1 text-xs leading-relaxed text-neutral-200">{title}</p>
                <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleCopy(title, i)}
                    title="复制标题"
                    className="p-1 rounded text-neutral-500 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
                  >
                    {copiedIndex === i ? (
                      <Check size={12} className="text-emerald-400" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                  {currentContent && (
                    <button
                      onClick={() => handleApply(title)}
                      title="应用为当前内容标题"
                      className="p-1 rounded text-neutral-500 hover:text-pink-300 hover:bg-pink-500/10 transition-colors"
                    >
                      <Type size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TitleFactoryPanel;
