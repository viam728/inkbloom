import React from 'react';
import {
  MessageSquareQuote,
  Loader2,
  Check,
  X,
  MapPin,
  ThumbsUp,
  Lightbulb,
  AlertTriangle,
} from 'lucide-react';
import { useReviewStore, locateTextInEditor, type ReviewSeverity } from '@/stores/review-store';
import { useNovelStore } from '@/stores/novel-store';
import { useEditorStore } from '@/stores/editor-store';

const SEVERITY_CONFIG: Record<
  ReviewSeverity,
  { label: string; icon: React.ReactNode; border: string; badge: string }
> = {
  praise: {
    label: '亮点',
    icon: <ThumbsUp size={12} />,
    border: 'border-l-emerald-400',
    badge: 'bg-emerald-500/15 text-emerald-300',
  },
  suggestion: {
    label: '建议',
    icon: <Lightbulb size={12} />,
    border: 'border-l-amber-400',
    badge: 'bg-amber-500/15 text-amber-300',
  },
  issue: {
    label: '问题',
    icon: <AlertTriangle size={12} />,
    border: 'border-l-red-400',
    badge: 'bg-red-500/15 text-red-300',
  },
};

/** AI 批注评审面板：像编辑一样逐条处理 AI 留下的批注 */
const ReviewPanel: React.FC = () => {
  const { annotations, reviewing, reviewedChapterId, runReview, resolve, dismiss, clear } =
    useReviewStore();
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const content = useEditorStore((s) => s.content);

  const handleRun = () => {
    if (!currentChapter) return;
    runReview(currentChapter.id, content);
  };

  const pending = annotations.filter((a) => !a.resolved).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/6">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-md shadow-amber-500/20">
            <MessageSquareQuote size={13} className="text-white" />
          </span>
          <span className="text-sm font-medium text-neutral-200">AI 批注评审</span>
          {pending > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25 tabular-nums">
              {pending} 待处理
            </span>
          )}
        </div>
        {annotations.length > 0 && (
          <button
            onClick={clear}
            className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="清空批注"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {annotations.length === 0 && !reviewing ? (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in-slow px-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-white/8 flex items-center justify-center mb-4">
              <MessageSquareQuote size={22} className="text-amber-300" />
            </div>
            <p className="text-sm font-medium text-neutral-300 mb-1">让 AI 做你的责任编辑</p>
            <p className="text-xs text-neutral-500 mb-5 leading-relaxed">
              对当前章节进行节奏、对话、钩子等维度的审阅，
              <br />
              留下可逐条处理的批注
            </p>
            <button
              onClick={handleRun}
              disabled={!currentChapter}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 disabled:from-neutral-700 disabled:to-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium transition-all shadow-lg shadow-amber-600/20 disabled:shadow-none"
            >
              {currentChapter ? '开始审阅本章' : '请先打开一个章节'}
            </button>
          </div>
        ) : (
          <>
            {reviewing && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-neutral-400 mb-2">
                <Loader2 size={13} className="animate-spin text-amber-400" />
                AI 正在审阅章节…
              </div>
            )}

            <div className="flex flex-col gap-2">
              {annotations.map((a) => {
                const cfg = SEVERITY_CONFIG[a.severity];
                return (
                  <div
                    key={a.id}
                    className={`rounded-lg bg-white/3 border border-white/6 border-l-2 ${cfg.border} px-3 py-2.5 transition-opacity ${
                      a.resolved ? 'opacity-45' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${cfg.badge}`}>
                        {cfg.icon}
                        {cfg.label}
                      </span>
                      <div className="flex-1" />
                      <button
                        onClick={() => locateTextInEditor(a.quote)}
                        title="定位到原文"
                        className="p-0.5 rounded text-neutral-500 hover:text-brand-300 hover:bg-white/8 transition-colors"
                      >
                        <MapPin size={12} />
                      </button>
                      {!a.resolved && (
                        <button
                          onClick={() => resolve(a.id)}
                          title="标记已处理"
                          className="p-0.5 rounded text-neutral-500 hover:text-emerald-400 hover:bg-white/8 transition-colors"
                        >
                          <Check size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => dismiss(a.id)}
                        title="移除批注"
                        className="p-0.5 rounded text-neutral-500 hover:text-red-400 hover:bg-white/8 transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>

                    {/* 原文引用 */}
                    <button
                      onClick={() => locateTextInEditor(a.quote)}
                      className="block w-full text-left text-[11px] text-neutral-500 italic border-l border-white/10 pl-2 mb-1.5 hover:text-brand-300 transition-colors truncate"
                      title={a.quote}
                    >
                      “{a.quote}”
                    </button>

                    <p className="text-xs text-neutral-300 leading-relaxed">{a.comment}</p>
                    {a.suggestion && (
                      <p className="mt-1.5 text-[11px] text-amber-200/70 bg-amber-500/8 rounded-md px-2 py-1.5 leading-relaxed">
                        💡 {a.suggestion}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 重新审阅 */}
            <div className="mt-3 flex justify-center">
              <button
                onClick={handleRun}
                disabled={reviewing || !currentChapter}
                className="text-[11px] px-3 py-1.5 rounded-lg border border-white/8 text-neutral-400 hover:text-neutral-200 hover:bg-white/6 disabled:opacity-40 transition-colors"
              >
                重新审阅当前章节
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      {reviewedChapterId && (
        <div className="px-3 py-1.5 border-t border-white/6 text-[10px] text-neutral-600">
          已审阅章节 #{reviewedChapterId}
        </div>
      )}
    </div>
  );
};

export default ReviewPanel;
