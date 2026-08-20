import { create } from 'zustand';
import apiClient from '@/services/api-client';

/** 冻结契约：订阅状态 */
export type SubStatus = 'trialing' | 'active' | 'grace' | 'dormant';

export interface Subscription {
  plan: string;
  status: SubStatus;
  started_at: string;
  expires_at: string;
  grace_until: string | null;
  days_left: number;
  read_only: boolean;
}

/** 冻结契约：支付订单 */
export type OrderStatus = 'created' | 'paid' | 'closed';

export interface PayOrder {
  order_id: string;
  kind: string;
  period: string;
  amount_cents: number;
  channel: string;
  status: OrderStatus;
  paid_at: string | null;
  created_at: string;
}

export type BillPeriod = 'month' | 'year';
export type PayChannel = 'sandbox' | 'alipay' | 'wechat';

interface SubscriptionState {
  subscription: Subscription | null;
  orders: PayOrder[];
  /** 订阅下单进行中 */
  subscribing: boolean;
  fetchSubscription: () => Promise<void>;
  loadOrders: (limit?: number) => Promise<void>;
  /** 下单订阅（当前仅 sandbox 通道可用），成功后自动刷新订阅状态 */
  subscribe: (period: BillPeriod, channel?: PayChannel) => Promise<void>;
}

export const useSubscriptionStore = create<SubscriptionState>()((set, get) => ({
  subscription: null,
  orders: [],
  subscribing: false,

  fetchSubscription: async () => {
    const data = (await apiClient.get('/subscription')) as unknown as Subscription;
    set({ subscription: data });
  },

  loadOrders: async (limit = 20) => {
    const data = (await apiClient.get('/payment/orders', {
      params: { limit },
    })) as unknown as { orders?: PayOrder[] };
    // 时间倒序（后端未保证顺序时兜底）
    const orders = [...(data?.orders ?? [])].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    set({ orders });
  },

  subscribe: async (period, channel = 'sandbox') => {
    set({ subscribing: true });
    try {
      await apiClient.post('/subscription/orders', { period, channel });
      // sandbox 下单即 paid，立即刷新订阅状态
      await get().fetchSubscription();
    } finally {
      set({ subscribing: false });
    }
  },
}));

/** 状态徽标展示元信息（文案与色彩） */
export const SUB_STATUS_META: Record<
  SubStatus,
  { label: string; badge: string; dot: string; alert: boolean }
> = {
  trialing: {
    label: '试用中',
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    dot: 'bg-sky-400',
    alert: false,
  },
  active: {
    label: '已订阅',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    dot: 'bg-emerald-400',
    alert: false,
  },
  grace: {
    label: '宽限期',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    dot: 'bg-amber-400',
    alert: true,
  },
  dormant: {
    label: '已休眠',
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    dot: 'bg-rose-400',
    alert: true,
  },
};

/** 订单状态中文映射 */
export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  created: '待支付',
  paid: '已支付',
  closed: '已关闭',
};

/** 金额：分 → 元 */
export function fmtAmount(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 日期格式化：yyyy-MM-dd */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}
