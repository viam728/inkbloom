import React, { useState } from 'react';
import { LoaderCircle, MessageSquare } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { toast } from '@/components/common/Toast';
import { useUIStore } from '@/stores/ui-store';
import apiClient from '@/services/api-client';

type Category = 'bug' | 'feature' | 'other';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'bug', label: '问题反馈' },
  { id: 'feature', label: '功能建议' },
  { id: 'other', label: '其他' },
];

const MAX_CONTENT = 2000;

function errMsg(e: unknown): string {
  const axiosMsg = (e as { response?: { data?: { message?: string } } })?.response?.data
    ?.message;
  if (axiosMsg) return axiosMsg;
  if (e instanceof Error && e.message) return e.message;
  return '网络异常，请稍后重试';
}

/** 意见反馈：分类 + 内容（≤2000 字）+ 联系方式选填 */
const FeedbackModal: React.FC = () => {
  const open = useUIStore((s) => s.feedbackOpen);
  const setOpen = useUIStore((s) => s.setFeedbackOpen);

  const [category, setCategory] = useState<Category>('bug');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const close = () => setOpen(false);

  const handleSubmit = async () => {
    if (submitting) return;
    if (!content.trim()) {
      toast.show('请填写反馈内容', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/feedback', {
        category,
        content: content.trim(),
        ...(contact.trim() ? { contact: contact.trim() } : {}),
      });
      toast.show('感谢反馈', 'success');
      setContent('');
      setContact('');
      setCategory('bug');
      close();
    } catch (e) {
      toast.show(errMsg(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <MessageSquare size={15} className="text-brand-300" />
          意见反馈
        </span>
      }
      width="460px"
    >
      <div className="p-5 space-y-4">
        {/* 分类三选一 */}
        <div className="flex gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all duration-200 ${
                category === c.id
                  ? 'border-brand-500/60 bg-brand-500/15 text-brand-300 shadow-[0_0_0_3px_rgba(99,102,241,0.1)]'
                  : 'border-white/8 bg-white/3 text-neutral-500 hover:text-neutral-300 hover:bg-white/6'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[11px] tracking-[0.18em] text-neutral-400">反馈内容</span>
            <span
              className={`text-[10px] tabular-nums ${
                content.length >= MAX_CONTENT ? 'text-rose-400' : 'text-neutral-600'
              }`}
            >
              {content.length}/{MAX_CONTENT}
            </span>
          </div>
          <textarea
            value={content}
            maxLength={MAX_CONTENT}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="描述你遇到的问题或建议，我们会认真阅读每一条反馈…"
            className="w-full resize-none bg-white/4 border border-white/8 rounded-xl px-3.5 py-2.5 text-sm text-neutral-100
              placeholder:text-neutral-600 outline-none transition-all duration-200
              focus:border-brand-500/60 focus:bg-white/6 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
          />
        </div>

        {/* 联系方式（选填） */}
        <div>
          <span className="flex items-baseline justify-between mb-1.5">
            <span className="text-[11px] tracking-[0.18em] text-neutral-400">联系方式</span>
            <span className="text-[10px] text-neutral-600">选填，便于我们回访</span>
          </span>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
            placeholder="手机号 / 邮箱"
            className="w-full bg-white/4 border border-white/8 rounded-xl px-3.5 py-2.5 text-sm text-neutral-100
              placeholder:text-neutral-600 outline-none transition-all duration-200
              focus:border-brand-500/60 focus:bg-white/6 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full py-2.5 rounded-xl text-sm font-semibold tracking-widest text-white
            bg-gradient-to-r from-indigo-500 via-brand-500 to-pink-500 bg-[length:200%_100%]
            hover:bg-right transition-all duration-300 shadow-lg shadow-indigo-500/25
            active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed
            flex items-center justify-center gap-2"
        >
          {submitting && <LoaderCircle size={15} className="animate-spin" />}
          提交反馈
        </button>
      </div>
    </Modal>
  );
};

export default FeedbackModal;
