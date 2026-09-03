import React from 'react';
import Modal from '@/components/common/Modal';
import {
  useAIStore,
  AI_SCENE_LABELS,
  type AIScene,
} from '@/stores/ai-store';
import { MODELS } from './ModelSelector';

/** 已知场景清单（保证展示顺序稳定） */
const SCENES: AIScene[] = ['agent', 'candidates', 'inline', 'rewrite', 'expand'];

/**
 * 场景模型配置：为不同 AI 场景单独指定模型；未设置的场景跟随全局模型选择。
 * 配置持久化在 localStorage（ai-store 负责）。
 */
const SceneModelSettings: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const currentModel = useAIStore((s) => s.currentModel);
  const sceneModels = useAIStore((s) => s.sceneModels);
  const setSceneModel = useAIStore((s) => s.setSceneModel);

  return (
    <Modal open={open} onClose={onClose} title="场景模型配置" width="440px">
      <div className="px-5 py-4">
        <p className="text-[11px] text-neutral-500 leading-relaxed mb-3">
          为不同创作场景单独指定模型；未设置的场景使用全局模型
          （当前：<span className="text-neutral-300">{currentModel}</span>）。
        </p>
        <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
          {SCENES.map((scene) => {
            const overridden = sceneModels[scene] || '';
            return (
              <div
                key={scene}
                className="flex items-center gap-3 rounded-lg bg-white/4 border border-white/8 px-3 py-2.5"
              >
                <span className="flex-1 min-w-0 text-xs text-neutral-200">
                  {AI_SCENE_LABELS[scene]}
                </span>
                <select
                  value={overridden}
                  onChange={(e) => setSceneModel(scene, e.target.value)}
                  className="w-[190px] shrink-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-brand-500/40"
                >
                  <option value="" className="bg-neutral-800">
                    跟随全局（{currentModel}）
                  </option>
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value} className="bg-neutral-800">
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};

export default SceneModelSettings;
