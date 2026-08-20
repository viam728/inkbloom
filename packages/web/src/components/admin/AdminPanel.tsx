import React, { useCallback, useEffect, useState } from 'react';
import { Settings2, RefreshCw, Ban, CheckCircle2, CalendarPlus, Coins } from 'lucide-react';
import Modal from '@/components/common/Modal';
import { toast } from '@/components/common/Toast';
import apiClient from '@/services/api-client';
import { useAuthStore, isAdmin } from '@/stores/auth-store';

/**
 * 运营后台 v1（任务 #49，M5）：自包含组件。
 * 仅 role>=1 的账号渲染左下角悬浮入口；面板为全屏 Modal，
 * 含看板 / 用户管理 / 订单三个 Tab。
 */

// ── 后端契约类型 ────────────────────────────────────────────────────────

interface DashboardData {
  users_total: number;
  users_today: number;
  subs_active: number;
  subs_trialing: number;
  subs_grace: number;
  token_balance_total: number;
  token_consumed_today: number;
  novels_total: number;
  ai_calls_today: number;
}

interface AdminSubscription {
  status: string;
  expires_at?: string;
}

interface AdminUserItem {
  id: number;
  phone: string;
  nickname: string;
  status: number;
  role: number;
  registered_channel: string;
  created_at: string;
  last_login_at?: string;
  subscription?: AdminSubscription;
  token_balance: number;
}

interface AdminUserList {
  total: number;
  items: AdminUserItem[];
}

interface AdminOrderItem {
  kind: string;
  id: number;
  user_id: number;
  amount_cents: number;
  tokens?: number;
  status: string;
  channel: string;
  out_trade_no: string;
  created_at: string;
  paid_at?: string;
}

type PendingAction =
  | { type: 'ban'; user: AdminUserItem }
  | { type: 'extend'; user: AdminUserItem }
  | { type: 'grant'; user: AdminUserItem };

// ── 小工具 ──────────────────────────────────────────────────────────────

function fmtTime(v?: string): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('zh-CN', { hour12: false });
}

function fmtMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

const subStatusText: Record<string, string> = {
  trialing: '试用中',
  active: '生效中',
  grace: '宽限期',
  dormant: '休眠',
};

const cardCls =
  'glass-panel rounded-xl px-4 py-3 flex flex-col gap-1 min-w-[130px] flex-1';
const cardLabelCls = 'text-[11px] text-neutral-500';
const cardValueCls = 'text-lg font-semibold text-neutral-100 tabular-nums';
const inputCls =
  'bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-indigo-400/60';
const btnCls =
  'px-2.5 py-1 rounded-lg text-xs transition-colors border border-white/10 text-neutral-300 hover:bg-white/10 inline-flex items-center gap-1';

// ── 看板 ────────────────────────────────────────────────────────────────

const DashboardTab: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await apiClient.get('/admin/dashboard')) as unknown as DashboardData;
      setData(d);
    } catch (e) {
      toast.show(`看板加载失败：${(e as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return <div className="p-6 text-sm text-neutral-500">加载中…</div>;
  }

  const cards: Array<{ label: string; value: string }> = [
    { label: '用户总数', value: String(data.users_total) },
    { label: '今日新增用户', value: String(data.users_today) },
    { label: '订阅生效中', value: String(data.subs_active) },
    { label: '订阅试用中', value: String(data.subs_trialing) },
    { label: '订阅宽限期', value: String(data.subs_grace) },
    { label: 'Token 余额总量', value: data.token_balance_total.toLocaleString() },
    { label: '今日 Token 消耗', value: data.token_consumed_today.toLocaleString() },
    { label: '作品总数', value: String(data.novels_total) },
    { label: '今日 AI 调用', value: String(data.ai_calls_today) },
  ];

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex justify-end">
        <button className={btnCls} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.label} className={cardCls}>
            <span className={cardLabelCls}>{c.label}</span>
            <span className={cardValueCls}>{c.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── 用户管理 ────────────────────────────────────────────────────────────

const UsersTab: React.FC = () => {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<AdminUserList | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [days, setDays] = useState('30');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const size = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), size: String(size) });
      if (search.trim()) params.set('search', search.trim());
      if (status !== 'all') params.set('status', status);
      const d = (await apiClient.get(`/admin/users?${params.toString()}`)) as unknown as AdminUserList;
      setList(d);
    } catch (e) {
      toast.show(`用户列表加载失败：${(e as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = list ? Math.max(1, Math.ceil(list.total / size)) : 1;

  const confirmAction = async () => {
    if (!pending) return;
    try {
      if (pending.type === 'ban') {
        const next = pending.user.status === 0 ? 1 : 0;
        await apiClient.post(`/admin/users/${pending.user.id}/status`, { status: next });
        toast.show(next === 1 ? '已禁用该用户' : '已恢复该用户', 'success');
      } else if (pending.type === 'extend') {
        const n = Number(days);
        if (!Number.isInteger(n) || n < 1) {
          toast.show('请输入有效的天数（≥1）', 'error');
          return;
        }
        await apiClient.post(`/admin/subscriptions/${pending.user.id}/extend`, { days: n });
        toast.show(`订阅已延长 ${n} 天`, 'success');
      } else {
        const n = Number(amount);
        if (!Number.isInteger(n) || n < 1) {
          toast.show('请输入有效的 Token 数量（≥1）', 'error');
          return;
        }
        await apiClient.post('/admin/token/grant', {
          user_id: pending.user.id,
          amount: n,
          note: note.trim(),
        });
        toast.show(`已发放 ${n.toLocaleString()} Token`, 'success');
      }
      setPending(null);
      setDays('30');
      setAmount('');
      setNote('');
      void load();
    } catch (e) {
      toast.show(`操作失败：${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="p-4 flex flex-col gap-3">
      {/* 筛选行 */}
      <div className="flex items-center gap-2">
        <input
          className={`${inputCls} w-56`}
          placeholder="搜索手机号 / 昵称 / UID"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load();
          }}
        />
        <select
          className={inputCls}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">已禁用</option>
        </select>
        <button className={btnCls} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 查询
        </button>
        <span className="ml-auto text-xs text-neutral-500">共 {list?.total ?? 0} 位用户</span>
      </div>

      {/* 用户表格 */}
      <div className="overflow-auto rounded-xl border border-white/8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-neutral-500 border-b border-white/8">
              <th className="px-3 py-2 font-medium">UID</th>
              <th className="px-3 py-2 font-medium">手机号</th>
              <th className="px-3 py-2 font-medium">昵称</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">角色</th>
              <th className="px-3 py-2 font-medium">订阅</th>
              <th className="px-3 py-2 font-medium">Token 余额</th>
              <th className="px-3 py-2 font-medium">注册时间</th>
              <th className="px-3 py-2 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(list?.items ?? []).map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0 text-neutral-300">
                <td className="px-3 py-2 tabular-nums">{u.id}</td>
                <td className="px-3 py-2">{u.phone || '—'}</td>
                <td className="px-3 py-2 max-w-[140px] truncate">{u.nickname}</td>
                <td className="px-3 py-2">
                  <span className={u.status === 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {u.status === 0 ? '正常' : '已禁用'}
                  </span>
                </td>
                <td className="px-3 py-2">{u.role >= 1 ? `运营(${u.role})` : '用户'}</td>
                <td className="px-3 py-2">
                  {u.subscription ? (
                    <span title={fmtTime(u.subscription.expires_at)}>
                      {subStatusText[u.subscription.status] ?? u.subscription.status}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">{u.token_balance.toLocaleString()}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtTime(u.created_at)}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    <button
                      className={btnCls}
                      title={u.status === 0 ? '禁用该用户' : '恢复该用户'}
                      onClick={() => setPending({ type: 'ban', user: u })}
                    >
                      {u.status === 0 ? <Ban size={12} /> : <CheckCircle2 size={12} />}
                      {u.status === 0 ? '禁用' : '恢复'}
                    </button>
                    <button
                      className={btnCls}
                      title="延长订阅"
                      onClick={() => setPending({ type: 'extend', user: u })}
                    >
                      <CalendarPlus size={12} /> 延期
                    </button>
                    <button
                      className={btnCls}
                      title="发放 Token"
                      onClick={() => setPending({ type: 'grant', user: u })}
                    >
                      <Coins size={12} /> 发放
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list && list.items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-neutral-500">
                  暂无匹配用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-end gap-2 text-xs text-neutral-400">
        <button className={btnCls} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          上一页
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          className={btnCls}
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>

      {/* 行内操作确认弹窗 */}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending?.type === 'ban'
            ? pending.user.status === 0
              ? '禁用用户确认'
              : '恢复用户确认'
            : pending?.type === 'extend'
              ? '延长订阅'
              : '发放 Token'
        }
        width="380px"
      >
        {pending && (
          <div className="p-4 flex flex-col gap-3 text-sm text-neutral-300">
            <div className="text-xs text-neutral-500">
              目标用户：#{pending.user.id} {pending.user.nickname}（{pending.user.phone || '无手机号'}）
            </div>
            {pending.type === 'ban' && (
              <p>
                {pending.user.status === 0
                  ? '禁用后该用户的新请求将被拒绝（403），确定禁用？'
                  : '确定恢复该用户的正常状态？'}
              </p>
            )}
            {pending.type === 'extend' && (
              <label className="flex items-center gap-2">
                延长天数
                <input
                  className={`${inputCls} w-28`}
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </label>
            )}
            {pending.type === 'grant' && (
              <>
                <label className="flex items-center gap-2">
                  数量
                  <input
                    className={`${inputCls} w-36`}
                    type="number"
                    min={1}
                    placeholder="如 500000"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2">
                  备注
                  <input
                    className={`${inputCls} flex-1`}
                    placeholder="选填（≤60 字）"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button className={btnCls} onClick={() => setPending(null)}>
                取消
              </button>
              <button
                className="px-3 py-1 rounded-lg text-xs bg-indigo-500/80 hover:bg-indigo-500 text-white transition-colors"
                onClick={() => void confirmAction()}
              >
                确认
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

// ── 订单 ────────────────────────────────────────────────────────────────

const OrdersTab: React.FC = () => {
  const [kind, setKind] = useState('all');
  const [items, setItems] = useState<AdminOrderItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (kind !== 'all') params.set('kind', kind);
      const d = (await apiClient.get(`/admin/orders?${params.toString()}`)) as unknown as {
        items: AdminOrderItem[];
      };
      setItems(d.items ?? []);
    } catch (e) {
      toast.show(`订单加载失败：${(e as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select
          className={inputCls}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">全部订单</option>
          <option value="subscription">订阅订单</option>
          <option value="token">Token 充值</option>
        </select>
        <button className={btnCls} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
        <span className="ml-auto text-xs text-neutral-500">最近 {items.length} 条</span>
      </div>

      <div className="overflow-auto rounded-xl border border-white/8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-neutral-500 border-b border-white/8">
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">订单号</th>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">金额</th>
              <th className="px-3 py-2 font-medium">Token</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">渠道</th>
              <th className="px-3 py-2 font-medium">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={`${o.kind}-${o.id}`} className="border-b border-white/5 last:border-0 text-neutral-300">
                <td className="px-3 py-2">{o.kind === 'token' ? 'Token 充值' : '订阅'}</td>
                <td className="px-3 py-2 font-mono text-xs">{o.out_trade_no}</td>
                <td className="px-3 py-2 tabular-nums">#{o.user_id}</td>
                <td className="px-3 py-2 tabular-nums">{fmtMoney(o.amount_cents)}</td>
                <td className="px-3 py-2 tabular-nums">
                  {o.tokens ? o.tokens.toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2">
                  <span className={o.status === 'paid' ? 'text-emerald-400' : 'text-neutral-400'}>
                    {o.status}
                  </span>
                </td>
                <td className="px-3 py-2">{o.channel}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtTime(o.created_at)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-neutral-500">
                  暂无订单
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── 主组件 ──────────────────────────────────────────────────────────────

type TabKey = 'dashboard' | 'users' | 'orders';

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'dashboard', label: '看板' },
  { key: 'users', label: '用户管理' },
  { key: 'orders', label: '订单' },
];

const AdminPanel: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('dashboard');

  // 非运营账号：不渲染任何 UI（入口按钮也不出现）
  if (!isAdmin(user)) return null;

  return (
    <>
      {/* 悬浮入口：左下角齿轮 */}
      {!open && (
        <button
          className="fixed left-4 bottom-4 z-[900] w-10 h-10 rounded-full glass-panel flex items-center justify-center text-neutral-400 hover:text-neutral-100 transition-colors"
          title="运营后台"
          onClick={() => setOpen(true)}
        >
          <Settings2 size={17} />
        </button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="运营后台" fullscreen>
        <div className="flex flex-col h-full">
          {/* Tab 切换 */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-white/8">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  tab === t.key
                    ? 'bg-indigo-500/20 text-indigo-300'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/5'
                }`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {tab === 'dashboard' && <DashboardTab />}
            {tab === 'users' && <UsersTab />}
            {tab === 'orders' && <OrdersTab />}
          </div>
        </div>
      </Modal>
    </>
  );
};

export default AdminPanel;
