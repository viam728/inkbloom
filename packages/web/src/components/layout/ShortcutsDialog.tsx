import React from 'react';
import Modal from '@/components/common/Modal';
import Kbd from '@/components/common/Kbd';
import { useUIStore } from '@/stores/ui-store';

interface ShortcutRow {
  keys: string[];
  desc: string;
}

const EDITOR_SHORTCUTS: ShortcutRow[] = [
  { keys: ['/'], desc: '斜杠命令菜单（AI 动作 / 格式块）' },
  { keys: ['Ctrl', 'Space'], desc: 'AI 行内续写' },
  { keys: ['Tab'], desc: '接受续写建议' },
  { keys: ['Esc'], desc: '关闭建议 / 退出专注模式' },
  { keys: ['@'], desc: '插入角色提及' },
  { keys: ['Ctrl', 'B'], desc: '加粗（编辑区内）' },
  { keys: ['Ctrl', 'I'], desc: '斜体（编辑区内）' },
];

const GLOBAL_SHORTCUTS: ShortcutRow[] = [
  { keys: ['Ctrl', 'K'], desc: '打开命令面板' },
  { keys: ['Ctrl', 'Shift', 'F'], desc: '专注写作模式' },
  { keys: ['Ctrl', 'B'], desc: '折叠 / 展开左侧栏' },
  { keys: ['Ctrl', 'J'], desc: '折叠 / 展开右侧 AI 面板' },
  { keys: ['Ctrl', '/'], desc: '打开本帮助' },
];

const ShortcutsDialog: React.FC = () => {
  const shortcutsOpen = useUIStore((s) => s.shortcutsOpen);
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);

  return (
    <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="键盘快捷键" width="440px">
      <div className="px-5 py-4 space-y-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            全局
          </p>
          <div className="space-y-1">
            {GLOBAL_SHORTCUTS.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/4">
                <span className="text-sm text-neutral-300">{s.desc}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            编辑器
          </p>
          <div className="space-y-1">
            {EDITOR_SHORTCUTS.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/4">
                <span className="text-sm text-neutral-300">{s.desc}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ShortcutsDialog;
