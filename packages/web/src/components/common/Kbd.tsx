import React from 'react';

interface KbdProps {
  children: React.ReactNode;
}

/** 键盘按键样式标签 */
const Kbd: React.FC<KbdProps> = ({ children }) => (
  <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded border border-white/12 bg-white/6 text-[11px] font-medium text-neutral-400 shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.4)]">
    {children}
  </kbd>
);

export default Kbd;
