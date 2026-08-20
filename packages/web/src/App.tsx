import { useEffect, useState } from 'react';
import { Flower2 } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import TopBar from '@/components/layout/TopBar';
import TaskStatusBar from '@/components/aigc/TaskStatusBar';
import { ToastProvider } from '@/components/common/Toast';
import AuthPage from '@/components/auth/AuthPage';
import LandingPage from '@/components/landing/LandingPage';
import LegalPage from '@/components/legal/LegalPage';
import SubscriptionModal from '@/components/billing/SubscriptionModal';
import TokenModal from '@/components/billing/TokenModal';
import AdminPanel from '@/components/admin/AdminPanel';
import { wsClient } from '@/services/ws-client';
import { buildWSURL } from '@/services/ws-url';
import { initAuth, useAuthStore } from '@/stores/auth-store';
import { useSubscriptionStore } from '@/stores/subscription-store';
import { useTokenStore } from '@/stores/token-store';
import { useFlagsStore } from '@/stores/flags-store';
import { isDesktopShell } from '@/utils/platform';
import { useUIStore } from '@/stores/ui-store';

/** 桌面端匿名本地用户标记（v2 §3.4）：与内嵌 server 的 uid=0 放行对应 */
const LOCAL_ANON_USER = {
  id: 0,
  phone: '',
  nickname: '本机用户',
  avatar_url: '',
  role: 0,
};
// Ensure WebSocket event handlers are registered
import '@/stores/aigc-store';

/**
 * 已鉴权主应用：仅在会话有效时挂载，
 * 业务 UI 与 WebSocket 均在此时才初始化。
 */
function AuthenticatedApp() {
  const accessToken = useAuthStore((s) => s.access_token);

  // 启动后拉取一次订阅状态与 Token 余额（失败静默，不阻断主流程）
  useEffect(() => {
    void useSubscriptionStore.getState().fetchSubscription().catch(() => {});
    void useTokenStore.getState().fetchBalance().catch(() => {});
  }, []);

  useEffect(() => {
    // 桌面端菜单「数据与云同步」（v2 §7.2）：主进程菜单 → 打开数据弹窗
    if (!isDesktopShell()) return;
    const off = window.electronAPI?.onMenuOpenDataModal?.(() => {
      useUIStore.getState().setDataOpen(true);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (isDesktopShell() && !accessToken) {
      // 桌面端免登录（v2 §3.4）：连接本地内嵌 server 的匿名 WS 通道，
      // 接收 AIGC 任务进度事件。云端登录后走下方鉴权分支重建连接。
      wsClient.connect(buildWSURL(''));
      return () => wsClient.disconnect();
    }
    if (!accessToken) return;
    // WS 与页面同源（桌面端 127.0.0.1:18080 / 云端 wss://host/ws），token 变化时重建连接
    wsClient.connect(buildWSURL(accessToken));
    return () => wsClient.disconnect();
  }, [accessToken]);

  return (
    <div className="flex flex-col h-screen">
      {/* 全局顶栏：Logo/角色切换/居中搜索/最大化/用户入口（专注模式内部隐藏） */}
      <TopBar />
      <AppLayout />
      <TaskStatusBar />
      {/* 订阅弹窗：用户入口与 402 拦截均可唤起 */}
      <SubscriptionModal />
      {/* Token 钱包弹窗：用户入口与余额不足 402 均可唤起 */}
      <TokenModal />
      {/* 运营后台（任务 #49）：组件内部按 role 决定是否渲染入口 */}
      <AdminPanel />
    </div>
  );
}

/** 未登录分支：落地页 ⇄ 登录/注册视图（本地 state，不持久化） */
function GuestApp() {
  const [view, setView] = useState<'landing' | 'auth'>('landing');
  return view === 'landing' ? (
    <LandingPage onEnterAuth={() => setView('auth')} />
  ) : (
    <AuthPage onBack={() => setView('landing')} />
  );
}

/** 启动会话校验中的过渡画面 */
const BootSplash = () => (
  <div className="h-screen w-full flex flex-col items-center justify-center gap-4 bg-surface-0">
    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30 animate-pulse-soft">
      <Flower2 size={24} className="text-white" />
    </div>
    <span className="text-xs tracking-[0.4em] text-neutral-500">INKBLOOM</span>
  </div>
);

function App() {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    // 桌面端（Electron 壳）免登录直进主界面（v2 §3.4）：本地内嵌 server
    // 以 uid=0 匿名放行全部 /api/v1 请求；AI/云同步等云端能力在使用时
    // 再唤起登录面板。
    if (isDesktopShell()) {
      const s = useAuthStore.getState();
      if (s.status === 'checking' && !s.access_token && !s.refresh_token) {
        useAuthStore.setState({ user: LOCAL_ANON_USER, status: 'authed' });
      } else {
        // 已有云端会话（持久化恢复）：走正常校验流程
        void initAuth();
      }
    } else {
      // Web 端：启动时校验本地会话：/auth/me → 失败 refresh 一次 → 再失败清空
      void initAuth();
    }
    // 拉取公开功能开关（含登录态场景，失败静默）
    void useFlagsStore.getState().fetchFlags().catch(() => {});
  }, []);

  return (
    <ToastProvider>
      {(() => {
        // 法务文档页（v2 §9.2）：/legal/:slug 无需登录，直接渲染
        const legalMatch = window.location.pathname.match(/^\/legal\/([\w-]+)/);
        if (legalMatch) {
          return <LegalPage slug={legalMatch[1]} />;
        }
        return status === 'authed' ? <AuthenticatedApp /> : status === 'guest' ? <GuestApp /> : <BootSplash />;
      })()}
    </ToastProvider>
  );
}

export default App;
