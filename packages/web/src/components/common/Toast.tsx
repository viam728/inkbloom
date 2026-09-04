import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  /** F2-8：相同文案的合并计数（≥2 时展示 ×N） */
  repeat?: number;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

let nextId = 0;

export const useToast = () => useContext(ToastContext);

// 命令式桥接：供 store 等非组件上下文弹 toast（Provider 未挂载时静默忽略）
type ShowToastFn = (message: string, type?: ToastType) => void;
let externalShow: ShowToastFn | null = null;

export const toast = {
  show: (message: string, type: ToastType = 'info') => {
    externalShow?.(message, type);
  },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++;
    setToasts((prev) => {
      // F2-8：相同文案合并为一条计数提示（多图逐个失败、并发 402 曾纵向
      // 堆叠遮挡界面）；总数上限 3 条，最旧的先被挤掉。
      const existing = prev.find((t) => t.message === message);
      if (existing) {
        return prev.map((t) =>
          t.message === message ? { ...t, repeat: (t.repeat ?? 1) + 1 } : t,
        );
      }
      const next = [...prev, { id, message, type }];
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  useEffect(() => {
    externalShow = showToast;
    return () => {
      if (externalShow === showToast) externalShow = null;
    };
  }, [showToast]);

  const styleMap: Record<ToastType, { border: string; icon: React.ReactNode }> = {
    success: {
      border: 'border-emerald-500/30',
      icon: <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />,
    },
    error: {
      border: 'border-red-500/30',
      icon: <AlertCircle size={15} className="text-red-400 shrink-0" />,
    },
    info: {
      border: 'border-white/10',
      icon: <Info size={15} className="text-brand-300 shrink-0" />,
    },
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Portal 到 body 且层级高于 Modal（z-[1000]），保证弹窗打开时反馈提示仍可见 */}
      {createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1100] flex flex-col items-center gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`glass-panel ${styleMap[t.type].border} flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm text-neutral-200 animate-slide-up`}
            >
              {styleMap[t.type].icon}
              {t.message}
              {(t.repeat ?? 1) > 1 && (
                <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-300">
                  ×{t.repeat}
                </span>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
};
