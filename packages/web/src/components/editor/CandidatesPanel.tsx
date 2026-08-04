import React, { useEffect } from 'react';
import { Sparkles, Check, X, RefreshCw, Loader2 } from 'lucide-react';
import { useCandidatesStore } from '@/stores/candidates-store';
import { AI_ACTION_LABELS } from '@/services/ai-actions-client';

interface CandidatesPanelProps {
  onAccept: (text: string) => void;
}

/** 多候选生成（N 选 1）浮层：在光标处展示多个候选版本供挑选 */
const CandidatesPanel: React.FC<CandidatesPanelProps> = ({ onAccept }) => {
  const { visible, loading, action, items, pos, error, dismiss, request } = useCandidatesStore();

  // 点击浮层外关闭
  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('candidates-panel');
      if (el && !el.contains(e.target as Node)) dismiss();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [visible, dismiss]);

  if (!visible || !pos) return null;

  const PANEL_W = 380;
  const left = Math.min(pos.left, window.innerWidth - PANEL_W - 16);
  const openUp = pos.top + 320 > window.innerHeight;

  return (
    <div
      id="candidates-panel"
      className="fixed z-40 glass-panel rounded-xl w-[380px] overflow-hidden animate-scale-in shadow-2xl shadow-black/50"
      style={
        openUp
          ? { left, bottom: window.innerHeight - pos.top + 8 }
          : { left, top: Math.min(pos.top + 8, window.innerHeight - 340) }
      }
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/8">
        <span className="w-5 h-5 rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
          <Sparkles size={11} className="text-white" />
        </span>
        <span className="text-xs font-medium text-neutral-200">
          {action ? `${AI_ACTION_LABELS[action]} · 候选` : 'AI 候选'}
        </span>
        <span className="text-[10px] text-neutral-500">N 选 1</span>
        <div className="flex-1" />
        {action && !loading && (
          <button
            onClick={() => request(action, useCandidatesContext() ?? '', pos)}
            title="换一批"
            className="p-1 rounded text-neutral-500 hover:text-brand-300 hover:bg-white/8 transition-colors"
          >
            <RefreshCw size={12} />
          </button>
        )}
        <button
          onClick={dismiss}
          title="关闭"
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* 内容 */}
      <div className="max-h-[280px] overflow-y-auto p-2 flex flex-col gap-1.5">
        {loading && (
          <>
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-neutral-400">
              <Loader2 size={13} className="animate-spin text-brand-400" />
              正在生成多个候选版本…
            </div>
            <div className="skeleton h-14 rounded-lg" />
            <div className="skeleton h-14 rounded-lg" />
            <div className="skeleton h-14 rounded-lg" />
          </>
        )}

        {!loading && error && (
          <div className="px-3 py-4 text-xs text-red-400 text-center">{error}</div>
        )}

        {!loading &&
          !error &&
          items.map((item, i) => (
            <div
              key={i}
              className="group relative rounded-lg border border-white/8 bg-white/3 hover:border-brand-500/40 hover:bg-brand-500/6 transition-all px-3 py-2.5"
            >
              <div className="flex items-start gap-2">
                <span className="shrink-0 mt-0.5 w-4.5 h-4.5 text-[10px] rounded bg-brand-500/15 text-brand-300 flex items-center justify-center font-medium">
                  {String.fromCharCode(65 + i)}
                </span>
                <p className="flex-1 text-[13px] leading-relaxed text-neutral-300 whitespace-pre-wrap">
                  {item}
                </p>
              </div>
              <button
                onClick={() => {
                  onAccept(item);
                  dismiss();
                }}
                className="mt-2 ml-6 flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-brand-600/25 text-brand-300 opacity-0 group-hover:opacity-100 hover:bg-brand-600/40 transition-all"
              >
                <Check size={11} />
                采纳插入
              </button>
            </div>
          ))}
      </div>

      <div className="px-3.5 py-1.5 border-t border-white/8 text-[10px] text-neutral-600">
        点击候选卡片上的「采纳插入」将内容写入编辑器
      </div>
    </div>
  );
};

/** 重试时尽量复用上次的上下文（由 store 记录） */
let lastContext: string | null = null;
export const setLastCandidatesContext = (ctx: string) => {
  lastContext = ctx;
};
const useCandidatesContext = () => lastContext;

export default CandidatesPanel;
