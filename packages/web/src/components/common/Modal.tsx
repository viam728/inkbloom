import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
  /** 顶部偏移定位（用于命令面板样式） */
  top?: boolean;
  /** 全屏模式：面板占 96vw × 90vh，覆盖 width 与默认 max-h */
  fullscreen?: boolean;
  /** 是否渲染最小化按钮（opt-in） */
  minimizable?: boolean;
  /** 受控最小化状态：true 时收起为悬浮标题栏，children 保持挂载 */
  minimized?: boolean;
  /** 最小化/恢复回调（受控，由宿主管理状态） */
  onMinimize?: (minimized: boolean) => void;
  /** 是否渲染最大化按钮（opt-in） */
  maximizable?: boolean;
  /** 全屏切换回调（受控，传了才渲染最大化按钮） */
  onToggleFullscreen?: () => void;
}

/** 模块级弹窗栈：管理 z-index 层级与 Esc 语义 */
const modalStack: symbol[] = [];
/** 栈变化订阅器：驱动各实例重算层级/栈顶状态 */
const stackListeners = new Set<() => void>();

function notifyStack() {
  stackListeners.forEach((fn) => fn());
}

/** push 到栈顶（已在栈顶则无操作，避免无谓重渲染） */
function pushToStack(id: symbol) {
  const idx = modalStack.indexOf(id);
  if (idx === modalStack.length - 1) return;
  if (idx !== -1) modalStack.splice(idx, 1);
  modalStack.push(id);
  notifyStack();
}

function removeFromStack(id: symbol) {
  const idx = modalStack.indexOf(id);
  if (idx === -1) return;
  modalStack.splice(idx, 1);
  notifyStack();
}

/** 最小化标题栏尺寸（用于拖拽钳制） */
const BAR_WIDTH = 220;
const BAR_HEIGHT = 34;

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

const headerBtnCls =
  'p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors';

const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  width = '420px',
  top = false,
  fullscreen = false,
  minimizable = false,
  minimized = false,
  onMinimize,
  maximizable = false,
  onToggleFullscreen,
}) => {
  const idRef = useRef<symbol | null>(null);
  if (!idRef.current) idRef.current = Symbol('modal');
  const id = idRef.current;

  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  /** 最小化标题栏位置（null 时使用默认右下角位置） */
  const [barPos, setBarPos] = useState<{ left: number; top: number } | null>(null);
  const dragMoved = useRef(false);

  // 订阅栈变化，重算 z-index 与栈顶状态
  useEffect(() => {
    stackListeners.add(forceRender);
    return () => {
      stackListeners.delete(forceRender);
    };
  }, []);

  // 入栈 / 出栈（关闭或卸载时移除）
  useEffect(() => {
    if (open) pushToStack(id);
    else removeFromStack(id);
    return () => removeFromStack(id);
  }, [open, id]);

  // Esc：仅栈顶且非 minimized 的实例响应；stopImmediatePropagation 阻断同层监听
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (minimized) return;
      if (modalStack[modalStack.length - 1] !== id) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose, minimized, id]);

  if (!open) return null;

  const stackIndex = modalStack.indexOf(id);
  // z-index = 1000 + 栈内索引，封顶 1099（不覆盖 Toast 的 1100）
  const zIndex = Math.min(1000 + (stackIndex === -1 ? 0 : stackIndex), 1099);
  const isTop = stackIndex !== -1 && stackIndex === modalStack.length - 1;

  // 默认位置：视口右下角（right:24px, bottom:24px 换算为 left/top）
  const defaultBarPos = {
    left: clamp(window.innerWidth - BAR_WIDTH - 24, 0, Math.max(0, window.innerWidth - BAR_WIDTH)),
    top: clamp(window.innerHeight - BAR_HEIGHT - 24, 0, Math.max(0, window.innerHeight - BAR_HEIGHT)),
  };
  const pos = barPos ?? defaultBarPos;

  // 标题栏拖拽：原生 pointer 事件，拖拽时钳制在视口内
  const handleBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pushToStack(id); // 点击提到最前
    if ((e.target as HTMLElement).closest('button')) return;
    dragMoved.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = barPos ?? defaultBarPos;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved.current = true;
      setBarPos({
        left: clamp(origin.left + dx, 0, Math.max(0, window.innerWidth - BAR_WIDTH)),
        top: clamp(origin.top + dy, 0, Math.max(0, window.innerHeight - BAR_HEIGHT)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Portal 到 body：避免祖先的 backdrop-filter/transform/filter 等将 fixed 弹窗困在局部层叠上下文内
  return createPortal(
    <>
      {/* 主形态：minimized 时仅 display:none 隐藏，children 保持挂载（挂起不卸载、草稿不丢） */}
      <div
        className={`fixed inset-0 flex ${top ? 'items-start pt-[14vh]' : 'items-center'} justify-center`}
        style={{ zIndex, display: minimized ? 'none' : undefined }}
        onMouseDown={
          isTop
            ? (e) => {
                if (e.target === e.currentTarget) onClose();
              }
            : undefined
        }
      >
        {/* 背景遮罩：仅栈顶且非 minimized 的实例渲染，避免多窗口并存时多层压暗 */}
        {isTop && !minimized && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-fade-in" onMouseDown={onClose} />
        )}

        {/* 面板 */}
        <div
          className={`relative glass-panel rounded-xl animate-scale-in flex flex-col ${
            fullscreen ? 'w-[96vw] h-[90vh] max-h-none' : 'max-h-[70vh]'
          }`}
          style={fullscreen ? undefined : { width }}
          role="dialog"
          aria-modal="true"
        >
          {title !== undefined && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
              <h3 className="text-sm font-semibold text-neutral-200">{title}</h3>
              <div className="flex items-center gap-1">
                {minimizable && (
                  <button
                    onClick={() => onMinimize?.(!minimized)}
                    className={headerBtnCls}
                    title="最小化"
                  >
                    <Minus size={15} />
                  </button>
                )}
                {maximizable && (
                  <button
                    onClick={onToggleFullscreen}
                    className={headerBtnCls}
                    title={fullscreen ? '退出全屏' : '全屏'}
                  >
                    {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                )}
                <button onClick={onClose} className={headerBtnCls} title="关闭">
                  <X size={15} />
                </button>
              </div>
            </div>
          )}
          <div className="overflow-y-auto">{children}</div>
        </div>
      </div>

      {/* minimized 形态：仅渲染悬浮标题栏 */}
      {minimized && (
        <div
          className="fixed glass-panel rounded-lg flex items-center gap-2 px-3 cursor-pointer select-none"
          style={{ left: pos.left, top: pos.top, width: BAR_WIDTH, height: BAR_HEIGHT, zIndex }}
          onPointerDown={handleBarPointerDown}
          onClick={() => {
            if (!dragMoved.current) onMinimize?.(false);
          }}
        >
          <span className="flex-1 truncate text-xs font-semibold text-neutral-200">{title}</span>
          <button
            className="p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
            title="恢复"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.(false);
            }}
          >
            <Minus size={13} />
          </button>
        </div>
      )}
    </>,
    document.body,
  );
};

export default Modal;
