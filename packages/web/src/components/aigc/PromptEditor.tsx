import React, { useState, useEffect } from 'react';
import { Palette, Loader2, RefreshCw, Check, X } from 'lucide-react';
import type { ImagePromptResult } from '@/services/prompt-client';

const STYLE_OPTIONS = [
  { label: '写实 (Realistic)', value: 'realistic' },
  { label: '动漫 (Anime)', value: 'anime' },
  { label: '水彩 (Watercolor)', value: 'watercolor' },
  { label: '油画 (Oil Painting)', value: 'oil_painting' },
  { label: '水墨 (Ink Wash)', value: 'ink_wash' },
  { label: '数字艺术 (Digital Art)', value: 'digital_art' },
];

interface PromptEditorProps {
  /** The auto-generated prompt result */
  result: ImagePromptResult | null;
  /** Currently selected style */
  style: string;
  /** Whether a prompt is being generated */
  loading: boolean;
  /** Called when the user confirms the prompt */
  onConfirm: (prompt: string, negativePrompt: string) => void;
  /** Called when the user wants to regenerate */
  onRegenerate: (style: string) => void;
  /** Called when style changes */
  onStyleChange: (style: string) => void;
  /** Called when the user cancels */
  onCancel: () => void;
}

const PromptEditor: React.FC<PromptEditorProps> = ({
  result,
  style,
  loading,
  onConfirm,
  onRegenerate,
  onStyleChange,
  onCancel,
}) => {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');

  useEffect(() => {
    if (result) {
      setPrompt(result.prompt);
      setNegativePrompt(result.negative_prompt);
    }
  }, [result]);

  const handleConfirm = () => {
    if (prompt.trim()) {
      onConfirm(prompt.trim(), negativePrompt.trim());
    }
  };

  const handleRegenerate = () => {
    onRegenerate(style);
  };

  return (
    <div className="space-y-3 rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.04] p-3 animate-slide-up">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300">
        <Palette size={11} />
        智能 Prompt 编辑
      </p>

      {/* Style selector */}
      <div className="flex gap-2 items-center">
        <label className="text-[11px] text-neutral-400 shrink-0">风格</label>
        <select
          value={style}
          onChange={(e) => onStyleChange(e.target.value)}
          disabled={loading}
          className="flex-1 bg-surface-2 text-neutral-300 text-xs rounded-lg px-2 py-1.5 border border-white/8 outline-none focus:border-brand-500/50 disabled:opacity-50 transition-colors"
        >
          {STYLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Generated prompt (editable) */}
      <div>
        <label className="text-[11px] text-neutral-400 block mb-1">
          图片 Prompt（可编辑）
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="自动生成的英文 Prompt 将显示在此处…"
          rows={4}
          disabled={loading}
          className="w-full bg-surface-2 text-neutral-200 text-xs rounded-lg px-3 py-2 border border-white/8 outline-none focus:border-brand-500/50 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.12)] resize-none placeholder-neutral-600 disabled:opacity-50 transition-all"
        />
      </div>

      {/* Negative prompt (editable) */}
      <div>
        <label className="text-[11px] text-neutral-400 block mb-1">
          Negative Prompt（排除内容）
        </label>
        <textarea
          value={negativePrompt}
          onChange={(e) => setNegativePrompt(e.target.value)}
          placeholder="不希望出现的内容…"
          rows={2}
          disabled={loading}
          className="w-full bg-surface-2 text-neutral-200 text-xs rounded-lg px-3 py-2 border border-white/8 outline-none focus:border-brand-500/50 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.12)] resize-none placeholder-neutral-600 disabled:opacity-50 transition-all"
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleRegenerate}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-1.5 bg-white/6 hover:bg-white/10 disabled:opacity-50 text-neutral-200 text-xs rounded-lg px-3 py-2 border border-white/8 transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {loading ? '生成中…' : '重新生成'}
        </button>
        <button
          onClick={handleConfirm}
          disabled={!prompt.trim() || loading}
          className="flex-1 flex items-center justify-center gap-1.5 bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:from-surface-3 disabled:to-surface-3 disabled:text-neutral-600 text-white text-xs font-medium rounded-lg px-3 py-2 transition-all"
        >
          <Check size={12} />
          确认填入
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="w-8 flex items-center justify-center bg-white/6 hover:bg-white/10 disabled:opacity-50 text-neutral-400 text-xs rounded-lg border border-white/8 transition-colors"
          title="取消"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

export default PromptEditor;
