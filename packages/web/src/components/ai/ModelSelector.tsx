import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp, Cpu, Zap, Sparkles, MessageSquareText, Bot, SlidersHorizontal } from 'lucide-react';
import { useAIStore } from '@/stores/ai-store';
import SceneModelSettings from './SceneModelSettings';

export interface ModelOption {
  value: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

/**
 * 可选模型列表。
 * 智谱 GLM 段为 API key 实际可调用的模型（GET /models 实测返回），
 * 走 open.bigmodel.cn OpenAI 兼容端点（ai-service 按 glm-* 前缀路由）。
 */
export const MODELS: ModelOption[] = [
  // 智谱 GLM（开发阶段统一默认 glm-4.5-air）
  {
    value: 'glm-4.5-air',
    label: 'glm-4.5-air',
    desc: '默认 · 开发统一 · 高性价比',
    icon: <Bot size={14} />,
  },
  {
    value: 'glm-5.3-flash',
    label: 'glm-5.3-flash',
    desc: '最快最省 · 轻量日常',
    icon: <Zap size={14} />,
  },
  {
    value: 'glm-5-turbo',
    label: 'glm-5-turbo',
    desc: '长任务 · 高性价比',
    icon: <Zap size={14} />,
  },
  {
    value: 'glm-5',
    label: 'glm-5',
    desc: '上一代旗舰 · 均衡',
    icon: <Cpu size={14} />,
  },
  {
    value: 'glm-5.1',
    label: 'glm-5.1',
    desc: '旗舰 · 200K 长程任务',
    icon: <Sparkles size={14} />,
  },
  {
    value: 'glm-5.2',
    label: 'glm-5.2',
    desc: '旗舰 · 1M 上下文',
    icon: <Cpu size={14} />,
  },
  {
    value: 'glm-5.3',
    label: 'glm-5.3',
    desc: '最新旗舰 · 复杂工程',
    icon: <Sparkles size={14} />,
  },
  {
    value: 'glm-4.5',
    label: 'glm-4.5',
    desc: '初代 4.5 · 稳定',
    icon: <MessageSquareText size={14} />,
  },
  {
    value: 'glm-4.6',
    label: 'glm-4.6',
    desc: '200K · 编码强',
    icon: <Cpu size={14} />,
  },
  {
    value: 'glm-4.7',
    label: 'glm-4.7',
    desc: '旗舰 · 深度构思',
    icon: <Sparkles size={14} />,
  },
  // DeepSeek（走默认 DeepSeek 兼容端点；未配置 OpenAI key，故不提供 gpt-* 选项）
  {
    value: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    desc: 'DeepSeek · 极速响应',
    icon: <Zap size={14} />,
  },
  {
    value: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    desc: 'DeepSeek · 深度构思',
    icon: <Sparkles size={14} />,
  },
  {
    value: 'deepseek-chat',
    label: 'deepseek-chat',
    desc: 'DeepSeek · 长文本推演',
    icon: <MessageSquareText size={14} />,
  },
];

/** 简约可展开的模型选择器：默认收起为胶囊，点击向上弹出模型列表 */
const ModelSelector: React.FC = () => {
  const currentModel = useAIStore((s) => s.currentModel);
  const sceneModels = useAIStore((s) => s.sceneModels);
  const setModel = useAIStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 本选择器挂在 AI 对话面板（agent 场景）：场景覆盖优先于全局选择。
  // 胶囊显示「实际生效」的对话模型，避免全局已切 DeepSeek 但对话仍走
  // 被 pin 的 GLM 时产生"模型没切换"的错觉。
  const agentPinned = sceneModels['agent'] || '';
  const effective = agentPinned || currentModel;
  const current = MODELS.find((m) => m.value === effective) ?? MODELS[0];

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
          {MODELS.map((m) => {
            const selected = m.value === currentModel;
            return (
              <button
                key={m.value}
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
            );
          })}
          {/* 场景模型配置入口 */}
          <button
            onClick={() => {
              setOpen(false);
              setSceneOpen(true);
            }}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 mt-1 border-t border-white/8 rounded-b-lg text-left text-neutral-400 hover:text-neutral-200 hover:bg-white/6 transition-colors"
          >
            <span className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center bg-white/6">
              <SlidersHorizontal size={12} />
            </span>
            <span className="flex-1 text-xs">场景模型配置</span>
          </button>
        </div>
      )}

      {/* 场景模型配置弹窗 */}
      <SceneModelSettings open={sceneOpen} onClose={() => setSceneOpen(false)} />

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
