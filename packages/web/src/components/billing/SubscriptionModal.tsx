import React, { useEffect, useState } from 'react';
import { CalendarDays, Check, Crown, LoaderCircle, Receipt } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { toast } from '@/components/common/Toast';
import { useUIStore } from '@/stores/ui-store';
import {
  ORDER_STATUS_TEXT,
  SUB_STATUS_META,
  fmtAmount,
  fmtDate,
  useSubscriptionStore,
  type BillPeriod,
} from '@/stores/subscription-store';

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '网络异常，请稍后重试';
}

/** 套餐卡片配置 */
const PLANS: {
  period: BillPeriod;
  title: string;
  price: number;
  unit: string;
  tag?: string;
}[] = [
  { period: 'month', title: '月付', price: 10, unit: '/月' },
  { period: 'year', title: '年付', price: 96, unit: '/年', tag: '立省 ¥24' },
];

/** 支付通道配置（alipay/wechat 后端暂未开放） */
const CHANNELS: { id: string; label: string; available: boolean }[] = [
  { id: 'sandbox', label: '沙箱支付', available: true },
  { id: 'alipay', label: '支付宝', available: false },
  { id: 'wechat', label: '微信支付', available: false },
];

const PERIOD_TEXT: Record<string, string> = { month: '月付', year: '年付' };
const CHANNEL_TEXT: Record<string, string> = {
  sandbox: '沙箱',
  alipay: '支付宝',
  wechat: '微信',
};

/** 订阅与会员中心：当前状态 / 套餐选购 / 订单历史 */
const SubscriptionModal: React.FC = () => {
  const open = useUIStore((s) => s.subscriptionOpen);
  const setOpen = useUIStore((s) => s.setSubscriptionOpen);
  const subscription = useSubscriptionStore((s) => s.subscription);
  const orders = useSubscriptionStore((s) => s.orders);
  const subscribing = useSubscriptionStore((s) => s.subscribing);
  const { fetchSubscription, loadOrders, subscribe } = useSubscriptionStore();

  const [period, setPeriod] = useState<BillPeriod>('year');
  const [minimized, setMinimized] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);

  // 打开时刷新订阅状态与订单历史
  useEffect(() => {
    if (!open) return;
    void fetchSubscription().catch(() => {});
    setOrdersLoading(true);
    loadOrders()
      .catch(() => {})
      .finally(() => setOrdersLoading(false));
  }, [open, fetchSubscription, loadOrders]);

  const meta = subscription ? SUB_STATUS_META[subscription.status] : null;

  const handleSubscribe = async () => {
    if (subscribing) return;
    try {
      await subscribe(period, 'sandbox');
      toast.show('订阅成功', 'success');
      void loadOrders().catch(() => {});
    } catch (e) {
      toast.show(errMsg(e), 'error');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={
        <span className="flex items-center gap-2">
          <Crown size={15} className="text-amber-300" />
          订阅与会员
        </span>
      }
      width="560px"
      minimizable
      minimized={minimized}
      onMinimize={setMinimized}
    >
      <div className="p-5 space-y-5">
        {/* ===== 当前订阅概览 ===== */}
        <section className="glass-panel rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <Crown size={18} className="text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-neutral-100">
                    InkBloom {subscription?.plan?.toUpperCase() ?? 'BASE'}
                  </span>
                  {meta && (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${meta.badge} ${
                        meta.alert ? 'animate-pulse-soft' : ''
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-neutral-500 flex items-center gap-1.5">
                  <CalendarDays size={11} />
                  {subscription
                    ? `${fmtDate(subscription.expires_at)} 到期${
                        subscription.days_left > 0 ? ` · 剩余 ${subscription.days_left} 天` : ''
                      }`
                    : '订阅信息获取中…'}
                </p>
              </div>
            </div>
          </div>
          {subscription?.read_only && (
            <p className="mt-3 px-3 py-2 rounded-lg text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/25">
              订阅已到期，当前为只读模式 —— 续费后即可恢复创作
            </p>
          )}
          {meta?.alert && !subscription?.read_only && (
            <p className="mt-3 px-3 py-2 rounded-lg text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25">
              {subscription?.status === 'grace'
                ? `宽限期至 ${fmtDate(subscription?.grace_until)}，请尽快续费以免中断创作`
                : '订阅已休眠，续费后立即恢复全部创作能力'}
            </p>
          )}
        </section>

        {/* ===== 套餐选择 ===== */}
        <section>
          <h4 className="text-[11px] tracking-[0.18em] text-neutral-500 mb-2.5">选择套餐</h4>
          <div className="grid grid-cols-2 gap-3">
            {PLANS.map((plan) => {
              const selected = period === plan.period;
              return (
                <button
                  key={plan.period}
                  type="button"
                  onClick={() => setPeriod(plan.period)}
                  className={`relative rounded-xl p-4 text-left border transition-all duration-200 ${
                    selected
                      ? 'border-brand-500/60 bg-brand-500/12 shadow-[0_0_0_3px_rgba(99,102,241,0.12)]'
                      : 'border-white/8 bg-white/3 hover:border-white/16 hover:bg-white/5'
                  }`}
                >
                  {plan.tag && (
                    <span className="absolute -top-2 right-3 px-2 py-0.5 rounded-full text-[9px] font-semibold bg-gradient-to-r from-amber-400 to-pink-500 text-surface-0 shadow-md">
                      {plan.tag}
                    </span>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-neutral-300">{plan.title}</span>
                    <span
                      className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                        selected
                          ? 'border-brand-400 bg-brand-500'
                          : 'border-white/20 bg-transparent'
                      }`}
                    >
                      {selected && <Check size={10} className="text-white" />}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span
                      className={`text-2xl font-bold ${
                        selected ? 'text-brand-200' : 'text-neutral-200'
                      }`}
                    >
                      ¥{plan.price}
                    </span>
                    <span className="text-[11px] text-neutral-500">{plan.unit}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 支付通道 */}
          <div className="mt-3 flex items-center gap-2">
            {CHANNELS.map((ch) => (
              <span
                key={ch.id}
                className={`px-2.5 py-1 rounded-lg text-[10px] border transition-colors ${
                  ch.available
                    ? 'border-brand-500/40 bg-brand-500/10 text-brand-300'
                    : 'border-white/6 bg-white/3 text-neutral-600'
                }`}
                title={ch.available ? '当前使用沙箱通道，下单即开通' : undefined}
              >
                {ch.label}
                {!ch.available && <span className="ml-1 text-neutral-700">· 即将开放</span>}
              </span>
            ))}
          </div>

          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            className="mt-4 w-full py-2.5 rounded-xl text-sm font-semibold tracking-widest text-white
              bg-gradient-to-r from-indigo-500 via-brand-500 to-pink-500 bg-[length:200%_100%]
              hover:bg-right transition-all duration-300 shadow-lg shadow-indigo-500/25
              active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed
              flex items-center justify-center gap-2"
          >
            {subscribing ? <LoaderCircle size={15} className="animate-spin" /> : <Crown size={15} />}
            立即订阅{period === 'year' ? ' · ¥96/年' : ' · ¥10/月'}
          </button>
        </section>

        {/* ===== 订单历史 ===== */}
        <section>
          <h4 className="text-[11px] tracking-[0.18em] text-neutral-500 mb-2.5 flex items-center gap-1.5">
            <Receipt size={12} />
            订单记录
          </h4>
          {ordersLoading && orders.length === 0 ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton h-10 w-full" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-neutral-600">暂无订单记录</p>
          ) : (
            <ul className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              {orders.map((o) => (
                <li
                  key={o.order_id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/3 border border-white/6 text-[11px]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-neutral-300 truncate">
                      {PERIOD_TEXT[o.period] ?? o.period}
                      <span className="text-neutral-600 ml-1.5">
                        {CHANNEL_TEXT[o.channel] ?? o.channel}
                      </span>
                    </div>
                    <div className="text-[10px] text-neutral-600 mt-0.5">
                      {fmtDate(o.created_at)}
                    </div>
                  </div>
                  <span className="text-neutral-200 font-medium shrink-0">
                    {fmtAmount(o.amount_cents)}
                  </span>
                  <span
                    className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] border ${
                      o.status === 'paid'
                        ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                        : o.status === 'created'
                          ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
                          : 'text-neutral-500 border-white/8 bg-white/4'
                    }`}
                  >
                    {ORDER_STATUS_TEXT[o.status] ?? o.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
};

export default SubscriptionModal;
