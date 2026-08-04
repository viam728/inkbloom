import React, { useEffect, useState } from 'react';
import { Lightbulb, RefreshCw, Copy, Loader2, MessageSquarePlus } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useUIStore } from '@/stores/ui-store';
import { useToast } from '@/components/common/Toast';
import {
  fetchInspiration,
  INSPIRATION_LABELS,
  type InspirationCategory,
} from '@/services/ai-actions-client';

const CATEGORIES = Object.keys(INSPIRATION_LABELS) as InspirationCategory[];

/** 灵感急救包：卡文时随机投喂剧情点子，可复制或丢给 AI 展开 */
const InspirationModal: React.FC = () => {
  const inspirationOpen = useUIStore((s) => s.inspirationOpen);
  const setInspirationOpen = useUIStore((s) => s.setInspirationOpen);
  const { showToast } = useToast();

  const [category, setCategory] = useState<InspirationCategory>('plot');
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const close = () => setInspirationOpen(false);

  const load = async (cat: InspirationCategory) => {
    setLoading(true);
    try {
      const result = await fetchInspiration(cat);
      setItems(result);
    } catch {
      setItems([]);
      showToast('灵感获取失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (inspirationOpen) load(category);
  }, [inspirationOpen, category]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制灵感', 'success');
    } catch {
      showToast('复制失败', 'error');
    }
  };

  /** 发送到 AI 助手展开讨论 */
  const handleSendToChat = (text: string) => {
    window.dispatchEvent(
      new CustomEvent('inkbloom:chat-draft', { detail: { text: `请围绕这个点子展开：${text}` } }),
    );
    close();
    showToast('已发送到 AI 助手', 'success');
  };

  return (
    <Modal open={inspirationOpen} onClose={close} title="灵感急救包" width="480px">
      <div className="px-4 py-3">
        {/* 分类切换 */}
        <div className="flex items-center gap-1.5 mb-3">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                category === c
                  ? 'bg-brand-600/25 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
              }`}
            >
              {INSPIRATION_LABELS[c]}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => load(category)}
            disabled={loading}
            title="换一批"
            className="p-1.5 rounded-md text-neutral-500 hover:text-brand-300 hover:bg-white/8 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* 灵感列表 */}
        <div className="flex flex-col gap-2 min-h-[180px]">
          {loading && (
            <>
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-neutral-500">
                <Loader2 size={13} className="animate-spin text-brand-400" />
                正在召唤灵感…
              </div>
              <div className="skeleton h-16 rounded-lg" />
              <div className="skeleton h-16 rounded-lg" />
            </>
          )}

          {!loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Lightbulb size={24} className="text-neutral-700 mb-2" />
              <p className="text-xs text-neutral-500">暂时没有灵感，点右上角换一批</p>
            </div>
          )}

          {!loading &&
            items.map((item, i) => (
              <div
                key={i}
                className="group rounded-lg border border-white/8 bg-white/3 hover:border-amber-500/40 hover:bg-amber-500/5 px-3 py-2.5 transition-all animate-fade-in"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="flex items-start gap-2">
                  <Lightbulb size={14} className="shrink-0 mt-0.5 text-amber-400" />
                  <p className="flex-1 text-[13px] text-neutral-200 leading-relaxed">{item}</p>
                </div>
                <div className="flex justify-end gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleCopy(item)}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-white/8 transition-colors"
                  >
                    <Copy size={11} />
                    复制
                  </button>
                  <button
                    onClick={() => handleSendToChat(item)}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md text-brand-300 hover:bg-brand-500/15 transition-colors"
                  >
                    <MessageSquarePlus size={11} />
                    让 AI 展开
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
};

export default InspirationModal;
