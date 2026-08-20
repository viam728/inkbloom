import { create } from 'zustand';
import apiClient from '@/services/api-client';

/** 冻结契约：Token 余额（单位=抵扣 token） */
export interface TokenBalance {
  balance: number;
  gift_balance: number;
  gift_expires_at: string | null;
  total_recharged: number;
  total_consumed: number;
  low_balance: boolean;
}

/** 冻结契约：消耗流水条目 */
export interface LedgerItem {
  id: number | string;
  /** 1=入账，-1=消耗 */
  direction: 1 | -1;
  amount: number;
  balance_after: number;
  reason: string;
  ref_type: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  endpoint: string;
  created_at: string;
}

/** 冻结契约：用量统计 */
export interface TokenStats {
  total: number;
  series: { bucket: string; consumed: number }[];
}

/** 冻结契约：充值订单 */
export interface TokenOrder {
  order_id: string;
  pack: string;
  tokens: number;
  amount_cents: number;
  channel: string;
  status: string;
  created_at: string;
}

export type TokenPack = 'standard' | 'pro';
export type StatsRange = 'day' | 'week' | 'month';

/** 套餐常量（前端写死展示） */
export const TOKEN_PACKS = {
  trial: {
    id: 'trial',
    name: '体验包',
    tokens: 500_000,
    price: 0,
    note: '注册即赠 · 90 天有效',
    purchasable: false,
  },
  standard: {
    id: 'standard',
    name: '标准包',
    tokens: 3_000_000,
    price: 9.9,
    note: '日常创作之选',
    purchasable: true,
  },
  pro: {
    id: 'pro',
    name: '专业包',
    tokens: 10_000_000,
    price: 25.9,
    note: '重度创作者专属',
    purchasable: true,
  },
} as const;

/** 流水 reason 中文映射（未收录时回退原文） */
export const REASON_TEXT: Record<string, string> = {
  chat: 'AI 对话',
  inline: '行内补全',
  rewrite: '润色改写',
  aigc: 'AIGC 生成',
  agent: '场景 Agent',
  analysis: '内容分析',
  portrait: '立绘生成',
  outline: '大纲生成',
  recharge: '充值到账',
  gift: '注册赠送',
  refund: '退还',
};

/** 千分位格式化 */
export function fmtTokens(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

interface TokenState {
  balance: TokenBalance | null;
  ledger: LedgerItem[];
  stats: TokenStats | null;
  statsRange: StatsRange;
  orders: TokenOrder[];
  /** 充值下单进行中 */
  purchasing: boolean;
  fetchBalance: () => Promise<void>;
  loadLedger: (limit?: number) => Promise<void>;
  loadStats: (range: StatsRange) => Promise<void>;
  /** 购买套餐（当前仅 sandbox 通道），成功后自动刷新余额 */
  buyPack: (pack: TokenPack) => Promise<void>;
  loadOrders: (limit?: number) => Promise<void>;
}

export const useTokenStore = create<TokenState>()((set, get) => ({
  balance: null,
  ledger: [],
  stats: null,
  statsRange: 'week',
  orders: [],
  purchasing: false,

  fetchBalance: async () => {
    const data = (await apiClient.get('/token/balance')) as unknown as TokenBalance;
    set({ balance: data });
  },

  loadLedger: async (limit = 50) => {
    const data = (await apiClient.get('/token/ledger', {
      params: { limit },
    })) as unknown as { items?: LedgerItem[] };
    set({ ledger: data?.items ?? [] });
  },

  loadStats: async (range) => {
    set({ statsRange: range });
    const data = (await apiClient.get('/token/stats', {
      params: { range },
    })) as unknown as TokenStats;
    set({ stats: data });
  },

  buyPack: async (pack) => {
    set({ purchasing: true });
    try {
      await apiClient.post('/token/orders', { pack, channel: 'sandbox' });
      // sandbox 立即到账，刷新余额
      await get().fetchBalance();
    } finally {
      set({ purchasing: false });
    }
  },

  loadOrders: async (limit = 20) => {
    const data = (await apiClient.get('/token/orders', {
      params: { limit },
    })) as unknown as { orders?: TokenOrder[] };
    set({ orders: data?.orders ?? [] });
  },
}));
