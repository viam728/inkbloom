import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 出错模块名，用于日志定位与降级文案（如「大纲面板」） */
  label?: string;
  /**
   * 重置键：变化时自动清除错误状态。
   * 用于切换作品 / 切换面板等场景，避免上一次的崩溃态残留。
   */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 渲染期错误边界：捕获子树的渲染 / 生命周期异常，降级为友好 UI 而非整页白屏。
 *
 * 项目里大纲面板等模块会渲染后端返回的结构化数据，一旦数据形状不符合契约
 * （如 act 缺少 nodes、node.status 非法），渲染时抛错会卸载整棵 React 树。
 * 用本组件包裹后，异常被限制在面板内，用户可点击「重试」重新渲染。
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  /** 渲染抛出异常时，用错误对象驱动降级 UI */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary]${this.props.label ? ` ${this.props.label}` : ''}`, error, info.componentStack);
  }

  /** resetKey 变化（如切换作品）时自动恢复，用户无需手动重试 */
  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  /** 重试：清空错误状态，重新渲染子树 */
  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const label = this.props.label ?? '此模块';
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="w-9 h-9 rounded-full bg-amber-500/12 border border-amber-500/25 flex items-center justify-center">
          <AlertTriangle size={16} className="text-amber-400" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold text-neutral-200">{label}加载失败</p>
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            数据显示时出了点问题，其余功能不受影响。
            <br />
            可以重试，或稍后再回来看看。
          </p>
        </div>
        <button
          onClick={this.handleRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] bg-white/6 border border-white/10 text-neutral-300 hover:text-neutral-100 hover:bg-white/10 transition-colors"
        >
          <RotateCcw size={12} />
          重试
        </button>
        {import.meta.env.DEV && (
          <p className="max-w-full break-all text-[10px] text-neutral-600 font-mono">
            {error.message}
          </p>
        )}
      </div>
    );
  }
}

export default ErrorBoundary;
