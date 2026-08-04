import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

let nextId = 0;

export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

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
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`glass-panel ${styleMap[t.type].border} flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm text-neutral-200 animate-slide-up`}
          >
            {styleMap[t.type].icon}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
