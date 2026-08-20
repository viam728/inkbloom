import React, { useEffect, useRef, useState } from 'react';
import { ChevronUp, Coins, Crown, Database, LogOut, MessageSquare } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import {
  SUB_STATUS_META,
  fmtDate,
  useSubscriptionStore,
} from '@/stores/subscription-store';
import { fmtTokens, useTokenStore } from '@/stores/token-store';
import { useFlagsStore } from '@/stores/flags-store';
import DataModal from '@/components/sync/DataModal';
import FeedbackModal from '@/components/feedback/FeedbackModal';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/components/common/Toast';

/** 订阅到期描述：按状态差异化展示 */
function expiryText(status: string, daysLeft: number, expiresAt: string, graceUntil: string | null): string {
  switch (status) {
    case 'trialing':
      return daysLeft > 0 ? `试用剩余 ${daysLeft} 天` : `试用至 ${fmtDate(expiresAt)}`;
    case 'active':
      return daysLeft > 0 ? `${fmtDate(expiresAt)} 到期 · 剩 ${daysLeft} 天` : `${fmtDate(expiresAt)} 到期`;
    case 'grace':
      return graceUntil ? `请于 ${fmtDate(graceUntil)} 前续费` : `宽限期内，请尽快续费`;
    case 'dormant':
      return '订阅已休眠，续费后恢复创作';
    default:
      return '';
  }
}

/**
 * 用户入口：头像 + 昵称，点击展开下拉。
 * 下拉包含订阅状态区块（徽标 + 到期信息 + 管理订阅）与登出。
 * 登出清空鉴权 store，App 条件渲染回到登录页。
 */
const UserMenu: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const subscription = useSubscriptionStore((s) => s.subscription);
  const tokenBalance = useTokenStore((s) => s.balance);
  const feedbackEnabled = useFlagsStore((s) => s.features.feedback);
  const setSubscriptionOpen = useUIStore((s) => s.setSubscriptionOpen);
  const setTokenOpen = useUIStore((s) => s.setTokenOpen);
  const setDataOpen = useUIStore((s) => s.setDataOpen);
  const setFeedbackOpen = useUIStore((s) => s.setFeedbackOpen);

  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const initial = (user?.nickname || user?.phone || '?').slice(0, 1).toUpperCase();
  const displayName = user?.nickname || user?.phone || '未命名用户';
  const meta = subscription ? SUB_STATUS_META[subscription.status] : null;

  const handleLogout = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await logout();
      toast.show('已退出登录', 'info');
    } finally {
      setLeaving(false);
    }
  };

  const handleManage = () => {
    setOpen(false);
    setSubscriptionOpen(true);
  };

  const handleToken = () => {
    setOpen(false);
    setTokenOpen(true);
  };

  const handleData = () => {
    setOpen(false);
    setDataOpen(true);
  };

  const handleFeedback = () => {
    setOpen(false);
    setFeedbackOpen(true);
  };

  const totalTokens = tokenBalance
    ? tokenBalance.balance + tokenBalance.gift_balance
    : null;

  const avatar = (size: 'sm' | 'md') => (
    <div
      className={`relative shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center font-semibold text-white shadow-md shadow-indigo-500/20 select-none ${
        size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-8 h-8 text-xs'
      }`}
    >
      {initial}
      {/* 订阅状态角标：grace/dormant 醒目呼吸 */}
      {meta && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface-1 ${meta.dot} ${
            meta.alert ? 'animate-pulse-soft' : ''
          }`}
        />
      )}
    </div>
  );

  /** 订阅状态区块（下拉内） */
  const subscriptionBlock = (
    <div className="px-3 py-3 border-b border-white/6">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.18em] text-neutral-500">订阅状态</span>
        {meta ? (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${meta.badge} ${
              meta.alert ? 'animate-pulse-soft' : ''
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        ) : (
          <span className="text-[10px] text-neutral-600">获取中…</span>
        )}
      </div>
      {subscription && (
        <p
          className={`mt-1.5 text-[11px] leading-relaxed ${
            meta?.alert ? 'text-amber-300' : 'text-neutral-400'
          }`}
        >
          {expiryText(subscription.status, subscription.days_left, subscription.expires_at, subscription.grace_until)}
        </p>
      )}
      {subscription?.read_only && (
        <p className="mt-1 text-[11px] text-rose-400">当前为只读模式，续费后可继续创作</p>
      )}
      <button
        onClick={handleManage}
        className="mt-2.5 w-full py-1.5 rounded-lg text-[11px] font-medium tracking-widest text-white
          bg-gradient-to-r from-indigo-500 to-pink-500 hover:opacity-90 transition-opacity
          shadow-md shadow-indigo-500/20 flex items-center justify-center gap-1.5"
      >
        <Crown size={12} />
        管理订阅
      </button>
    </div>
  );

  const popover = (
    <div
      className={`absolute z-50 w-60 glass-panel rounded-xl overflow-hidden animate-scale-in ${
        compact ? 'top-full right-0 mt-2' : 'bottom-full left-0 right-0 mb-2 w-auto'
      }`}
    >
      <div className="px-3 py-3 border-b border-white/6 flex items-center gap-2.5">
        {avatar('sm')}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-neutral-200 truncate">{displayName}</div>
          <div className="text-[10px] text-neutral-600 truncate">{user?.phone ?? ''}</div>
        </div>
      </div>

      {subscriptionBlock}

      {/* Token 余额行：合计（付费+赠送）千分位，low_balance 琥珀警示 */}
      <button
        onClick={handleToken}
        className="w-full flex items-center gap-2 px-3 py-2.5 border-b border-white/6 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/4 transition-colors"
      >
        <Coins size={13} className="text-amber-300/80" />
        Token 余额
        {tokenBalance?.low_balance && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse-soft">
            余额偏低
          </span>
        )}
        <span className="ml-auto font-medium tabular-nums text-neutral-300">
          {totalTokens === null ? '—' : fmtTokens(totalTokens)}
        </span>
      </button>

      {/* 数据管理：导出/导入 .inkbloom 备份包 */}
      <button
        onClick={handleData}
        className="w-full flex items-center gap-2 px-3 py-2.5 border-b border-white/6 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/4 transition-colors"
      >
        <Database size={13} className="text-brand-300/80" />
        数据管理
      </button>

      {/* 意见反馈：features.feedback 关闭时隐藏入口 */}
      {feedbackEnabled && (
        <button
          onClick={handleFeedback}
          className="w-full flex items-center gap-2 px-3 py-2.5 border-b border-white/6 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/4 transition-colors"
        >
          <MessageSquare size={13} className="text-emerald-300/80" />
          意见反馈
        </button>
      )}

      <button
        onClick={handleLogout}
        disabled={leaving}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-neutral-400 hover:text-red-400 hover:bg-red-500/8 transition-colors disabled:opacity-50"
      >
        <LogOut size={13} />
        退出登录
      </button>
    </div>
  );

  if (compact) {
    return (
      <div ref={rootRef} className="relative">
        <button onClick={() => setOpen((o) => !o)} title={displayName} className="block">
          {avatar('sm')}
        </button>
        {open && popover}
        {/* 弹窗 Portal 到 body，挂载于此避免修改 App.tsx */}
        <DataModal />
        <FeedbackModal />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 border-t border-white/6 bg-surface-1 hover:bg-surface-2 transition-colors"
      >
        {avatar('md')}
        <div className="flex-1 min-w-0 text-left">
          <div className="text-xs font-medium text-neutral-200 truncate">{displayName}</div>
          <div className="text-[10px] text-neutral-600 truncate">{user?.phone ?? ''}</div>
        </div>
        {meta && meta.alert ? (
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-medium border animate-pulse-soft ${meta.badge}`}
          >
            {meta.label}
          </span>
        ) : (
          <ChevronUp
            size={14}
            className={`text-neutral-600 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {open && popover}
      {/* 弹窗 Portal 到 body，挂载于此避免修改 App.tsx */}
      <DataModal />
      <FeedbackModal />
    </div>
  );
};

export default UserMenu;
