import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp, Cpu, Zap, Sparkles, MessageSquareText, Bot } from 'lucide-react';
import { useAIStore } from '@/stores/ai-store';

export interface ModelOption {
  value: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  /** 厂商分组名：下拉列表中变化时插入分组标题 */
  group?: string;
}

export const MODELS: ModelOption[] = [
  {
    value: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    desc: '极速响应 · 默认模型',
    icon: <Zap size={14} />,
    group: 'DeepSeek / OpenAI',
  },
  {
    value: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    desc: '旗舰能力 · 深度构思',
    icon: <Sparkles size={14} />,
    group: 'DeepSeek / OpenAI',
  },
  {
    value: 'gpt-4o-mini',
    label: 'GPT-4o Mini',
    desc: '快速轻量 · 日常创作',
    icon: <MessageSquareText size={14} />,
    group: 'DeepSeek / OpenAI',
  },
  {
    value: 'gpt-4o',
    label: 'GPT-4o',
    desc: '旗舰能力 · 深度构思',
    icon: <Cpu size={14} />,
    group: 'DeepSeek / OpenAI',
  },
  {
    value: 'deepseek-chat',
    label: 'DeepSeek Chat',
    desc: '长文本 · 情节推演',
    icon: <MessageSquareText size={14} />,
    group: 'DeepSeek / OpenAI',
  },
  // 智谱 GLM（按 tokens 计费基础模型，走 open.bigmodel.cn OpenAI 兼容端点）
  {
    value: 'glm-4.5-air',
    label: 'GLM-4.5 Air',
    desc: '高性价比 · 轻量主力',
    icon: <Bot size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.5-airx',
    label: 'GLM-4.5 AirX',
    desc: '极速响应 · 轻量强性能',
    icon: <Zap size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.5-flash',
    label: 'GLM-4.5 Flash',
    desc: '免费 · 日常创作',
    icon: <MessageSquareText size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.7-flash',
    label: 'GLM-4.7 Flash',
    desc: '免费 · 新一代轻量',
    icon: <MessageSquareText size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.7-flashx',
    label: 'GLM-4.7 FlashX',
    desc: '极速 · 超低成本',
    icon: <Zap size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.6',
    label: 'GLM-4.6',
    desc: '旗舰 · 200K 上下文',
    icon: <Cpu size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4.7',
    label: 'GLM-4.7',
    desc: '旗舰 · 深度构思',
    icon: <Sparkles size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-5.1',
    label: 'GLM-5.1',
    desc: '旗舰 · 200K 长程任务',
    icon: <Sparkles size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-5.2',
    label: 'GLM-5.2',
    desc: '旗舰 · 1M 上下文',
    icon: <Cpu size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-5.3',
    label: 'GLM-5.3',
    desc: '最新旗舰 · 复杂工程',
    icon: <Sparkles size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-plus',
    label: 'GLM-4 Plus',
    desc: '上一代旗舰 · 稳定',
    icon: <Cpu size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-air-250414',
    label: 'GLM-4 Air',
    desc: '轻量 · 长期支持版',
    icon: <MessageSquareText size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-airx',
    label: 'GLM-4 AirX',
    desc: '极速 · 轻量',
    icon: <Zap size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-flash-250414',
    label: 'GLM-4 Flash',
    desc: '免费 · 基础速写',
    icon: <MessageSquareText size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-flashx-250414',
    label: 'GLM-4 FlashX',
    desc: '极速 · 超低成本',
    icon: <Zap size={14} />,
    group: '智谱 GLM',
  },
  {
    value: 'glm-4-long',
    label: 'GLM-4 Long',
    desc: '1M 超长上下文 · 整本小说',
    icon: <MessageSquareText size={14} />,
    group: '智谱 GLM',
  },
];

/** 简约可展开的模型选择器：默认收起为胶囊，点击向上弹出模型列表 */
const ModelSelector: React.FC = () => {
  const currentModel = useAIStore((s) => s.currentModel);
  const setModel = useAIStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.value === currentModel) ?? MODELS[0];

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      {/* 向上弹出的模型列表 */}
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-56 glass-panel rounded-xl p-1.5 z-40 animate-scale-in origin-bottom-left max-h-[70vh] overflow-y-auto">
          <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            选择模型
          </p>
          {MODELS.map((m, i) => {
            const selected = m.value === currentModel;
            const showGroupHeader = m.group && (i === 0 || MODELS[i - 1].group !== m.group);
            return (
              <React.Fragment key={m.value}>
                {showGroupHeader && (
                  <p className="px-2.5 pt-2 pb-1 text-[10px] font-semibold text-neutral-600 border-t border-white/5 first:border-0">
                    {m.group}
                  </p>
                )}
                <button
                onClick={() => {
                  setModel(m.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                  selected ? 'bg-brand-600/15' : 'hover:bg-white/6'
                }`}
              >
                <span
                  className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center ${
                    selected
                      ? 'bg-brand-500/25 text-brand-300'
                      : 'bg-white/6 text-neutral-400'
                  }`}
                >
                  {m.icon}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={`block text-xs font-medium truncate ${
                      selected ? 'text-brand-300' : 'text-neutral-200'
                    }`}
                  >
                    {m.label}
                  </span>
                  <span className="block text-[10px] text-neutral-500 truncate">{m.desc}</span>
                </span>
                {selected && <Check size={13} className="shrink-0 text-brand-400" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* 收起态：简约胶囊按钮 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="切换 AI 模型"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all duration-150 ${
          open
            ? 'bg-brand-600/20 text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
            : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/6'
        }`}
      >
        <Cpu size={13} className={open ? 'text-brand-400' : 'text-neutral-500'} />
        <span className="max-w-[110px] truncate">{current.label}</span>
        <ChevronUp
          size={12}
          className={`text-neutral-500 transition-transform duration-200 ${open ? '' : 'rotate-180'}`}
        />
      </button>
    </div>
  );
};

export default ModelSelector;
