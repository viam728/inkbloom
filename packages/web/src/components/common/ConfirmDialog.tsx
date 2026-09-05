import React from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';

export interface ConfirmOptions {
  /** 弹窗标题，默认「确认操作」 */
  title?: string;
  /** 正文内容（支持 ReactNode） */
  message: React.ReactNode;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 危险操作：确认按钮红色系 */
  danger?: boolean;
}

/**
 * 自制警告确认弹窗（替代浏览器原生 window.confirm）：
 * 基于全局 Modal（portal 到 body + 弹窗栈管理 Esc/遮罩语义），
 * Promise 风格与 window.confirm 同构——`if (!(await confirmDialog(...))) return;` 即可平替。
 * 每次调用临时挂载独立 React root，关闭后卸载，不污染应用树。
 */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const cleanup = (result: boolean) => {
      resolve(result);
      // 让 Modal 先退出渲染循环，再卸载 root（同步 unmount 在事件回调里不安全）
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };

    root.render(
      <Modal
        open
        onClose={() => cleanup(false)}
        title={o.title ?? '确认操作'}
        width="360px"
      >
        <div className="px-5 py-4">
          <div className="flex items-start gap-3">
            <span
              className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                o.danger ? 'bg-red-500/12 text-red-400' : 'bg-amber-500/12 text-amber-400'
              }`}
            >
              <AlertTriangle size={16} />
            </span>
            <div className="flex-1 min-w-0 text-sm text-neutral-200 leading-relaxed pt-1">
              {o.message}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={() => cleanup(false)}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              {o.cancelText ?? '取消'}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => cleanup(true)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-all shadow-lg ${
                o.danger
                  ? 'bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 shadow-red-600/20'
                  : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-indigo-600/20'
              }`}
            >
              {o.confirmText ?? '确定'}
            </button>
          </div>
        </div>
      </Modal>,
    );
  });
}
