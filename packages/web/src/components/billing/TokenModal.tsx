import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Coins,
  Flame,
  Gift,
  LoaderCircle,
  ScrollText,
  TrendingDown,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import { toast } from '@/components/common/Toast';
import { useUIStore } from '@/stores/ui-store';
import { fmtDate } from '@/stores/subscription-store';
import {
  REASON_TEXT,
  TOKEN_PACKS,
  fmtTokens,
  useTokenStore,
  type StatsRange,
  type TokenPack,
} from '@/stores/token-store';

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '网络异常，请稍后重试';
}

/** 流水时间：MM-dd HH:mm */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${m}-${dd} ${hh}:${mm}`;
}

const RANGE_TABS: { id: StatsRange; label: string }[] = [
  { id: 'day', label: '今日' },
  { id: 'week', label: '近 7 天' },
  { id: 'month', label: '近 30 天' },
];

/** 支付通道（与订阅弹窗一致：仅沙箱可用） */
const CHANNELS: { id: string; label: string; available: boolean }[] = [
  { id: 'sandbox', label: '沙箱支付', available: true },
  { id: 'alipay', label: '支付宝', available: false },
  { id: 'wechat', label: '微信支付', available: false },
];

/** 用量柱状图：纯 div 实现，不引第三方图表库 */
const UsageBars: React.FC<{ series: { bucket: string; consumed: number }[] }> = ({ series }) => {
  if (series.length === 0) {
    return <p className="h-24 flex items-center justify-center text-[11px] text-neutral-600">暂无用量数据</p>;
  }
  const max = Math.max(...series.map((s) => s.consumed), 1);
  return (
    <div>
      <div className="h-24 flex items-end gap-[3px]">
        {series.map((s) => {
          const h = s.consumed <= 0 ? 2 : Math.max(3, (s.consumed / max) * 100);
          return (
            <div
              key={s.bucket}
              title={`${s.bucket} · 消耗 ${fmtTokens(s.consumed)} Token`}
              className="flex-1 min-w-0 rounded-t-sm bg-gradient-to-t from-brand-600/70 to-brand-400/90 hover:to-pink-400/90 transition-colors"
              style={{ height: `${h}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[9px] text-neutral-600">
        <span>{series[0].bucket}</span>
        {series.length > 2 && <span>{series[Math.floor(series.length / 2)].bucket}</span>}
        <span>{series[series.length - 1].bucket}</span>
      </div>
    </div>
  );
};

/** Token 钱包：余额概览 / 充值套餐 / 用量统计 / 消耗明细 */
const TokenModal: React.FC = () => {
  const open = useUIStore((s) => s.tokenOpen);
  const setOpen = useUIStore((s) => s.setTokenOpen);
  const balance = useTokenStore((s) => s.balance);
  const ledger = useTokenStore((s) => s.ledger);
  const stats = useTokenStore((s) => s.stats);
  const statsRange = useTokenStore((s) => s.statsRange);
  const purchasing = useTokenStore((s) => s.purchasing);
  const { fetchBalance, loadLedger, loadStats } = useTokenStore();

  const [minimized, setMinimized] = useState(false);

  // 打开时刷新余额 / 流水 / 统计
  useEffect(() => {
    if (!open) return;
    void fetchBalance().catch(() => {});
    void loadLedger().catch(() => {});
    void loadStats(useTokenStore.getState().statsRange).catch(() => {});
  }, [open, fetchBalance, loadLedger, loadStats]);

  const total = balance ? balance.balance + balance.gift_balance : null;

  const handleBuy = async (pack: TokenPack) => {
    if (purchasing) return;
    try {
      await useTokenStore.getState().buyPack(pack);
      toast.show('充值成功', 'success');
      void loadLedger().catch(() => {});
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
          <Coins size={15} className="text-amber-300" />
          Token 钱包
        </span>
      }
      width="600px"
      minimizable
      minimized={minimized}
      onMinimize={setMinimized}
    >
      <div className="p-5 space-y-5">
        {/* ===== 余额概览 ===== */}
        <section className="glass-panel rounded-xl p-4 relative overflow-hidden">
          <div
            aria-hidden
            className="absolute -right-10 -top-12 w-40 h-40 rounded-full bg-amber-500/10 blur-3xl pointer-events-none"
          />
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.18em] text-neutral-500">总余额</p>
              <p className="mt-1 text-3xl font-bold tabular-nums bg-gradient-to-r from-amber-200 to-pink-300 bg-clip-text text-transparent">
                {total === null ? '—' : fmtTokens(total)}
                <span className="ml-1.5 text-xs font-normal text-neutral-500">Token</span>
              </p>
              {balance?.low_balance && (
                <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse-soft">
                  <Flame size={10} />
                  余额偏低，建议尽快充值
                </span>
              )}
            </div>
            <div className="text-right space-y-1.5 text-[11px] text-neutral-500">
              <p className="flex items-center justify-end gap-1.5">
                <Gift size={11} className="text-pink-300/70" />
                赠送余额 {balance ? fmtTokens(balance.gift_balance) : '—'}
                {balance?.gift_expires_at && (
                  <span className="text-neutral-600">（{fmtDate(balance.gift_expires_at)} 到期）</span>
                )}
              </p>
              <p className="flex items-center justify-end gap-1.5">
                <TrendingDown size={11} className="text-brand-300/70" />
                累计消耗 {balance ? fmtTokens(balance.total_consumed) : '—'}
              </p>
            </div>
          </div>
        </section>

        {/* ===== 充值套餐 ===== */}
        <section>
          <h4 className="text-[11px] tracking-[0.18em] text-neutral-500 mb-2.5">充值套餐</h4>
          <div className="grid grid-cols-3 gap-3">
            {[TOKEN_PACKS.trial, TOKEN_PACKS.standard, TOKEN_PACKS.pro].map((pack) => {
              const buyable = pack.purchasable;
              return (
                <div
                  key={pack.id}
                  className={`rounded-xl p-3.5 border flex flex-col transition-colors ${
                    buyable
                      ? 'border-white/8 bg-white/3 hover:border-brand-500/40'
                      : 'border-white/5 bg-white/2 opacity-75'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-neutral-300">{pack.name}</span>
                    {pack.id === 'pro' && (
                      <span className="px-1.5 py-0.5 rounded text-[8px] font-semibold bg-gradient-to-r from-amber-400 to-pink-500 text-surface-0">
                        超值
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm font-bold tabular-nums text-neutral-100">
                    {fmtTokens(pack.tokens)}
                    <span className="ml-1 text-[10px] font-normal text-neutral-500">Token</span>
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-600">{pack.note}</p>
                  {buyable ? (
                    <>
                      <p className="mt-2 text-base font-bold text-brand-200">¥{pack.price}</p>
                      <button
                        onClick={() => handleBuy(pack.id as TokenPack)}
                        disabled={purchasing}
                        className="mt-2 w-full py-1.5 rounded-lg text-[11px] font-medium tracking-wider text-white
                          bg-gradient-to-r from-indigo-500 to-pink-500 hover:opacity-90 transition-opacity
                          shadow-md shadow-indigo-500/20 disabled:opacity-60 disabled:cursor-not-allowed
                          flex items-center justify-center gap-1.5"
                      >
                        {purchasing && <LoaderCircle size={11} className="animate-spin" />}
                        立即充值
                      </button>
                    </>
                  ) : (
                    <span className="mt-2 inline-flex w-full items-center justify-center py-1.5 rounded-lg text-[10px] border border-white/8 text-neutral-500 select-none">
                      注册即赠 · 不可购买
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            {CHANNELS.map((ch) => (
              <span
                key={ch.id}
                className={`px-2.5 py-1 rounded-lg text-[10px] border ${
                  ch.available
                    ? 'border-brand-500/40 bg-brand-500/10 text-brand-300'
                    : 'border-white/6 bg-white/3 text-neutral-600'
                }`}
              >
                {ch.label}
                {!ch.available && <span className="ml-1 text-neutral-700">· 即将开放</span>}
              </span>
            ))}
          </div>
        </section>

        {/* ===== 用量统计 ===== */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h4 className="text-[11px] tracking-[0.18em] text-neutral-500 flex items-center gap-1.5">
              <BarChart3 size={12} />
              用量统计
            </h4>
            <div className="flex gap-1 p-0.5 rounded-lg bg-white/4 border border-white/6">
              {RANGE_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void loadStats(t.id).catch(() => {})}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    statsRange === t.id
                      ? 'bg-brand-600/25 text-brand-300'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="glass-panel rounded-xl p-3.5">
            {stats ? (
              <>
                <UsageBars series={stats.series} />
                <p className="mt-2.5 text-[10px] text-neutral-500 text-right">
                  区间合计
                  <span className="ml-1.5 text-xs font-semibold tabular-nums text-neutral-300">
                    {fmtTokens(stats.total)}
                  </span>
                  <span className="ml-1">Token</span>
                </p>
              </>
            ) : (
              <div className="skeleton h-28 w-full" />
            )}
          </div>
        </section>

        {/* ===== 消耗明细 ===== */}
        <section>
          <h4 className="text-[11px] tracking-[0.18em] text-neutral-500 mb-2.5 flex items-center gap-1.5">
            <ScrollText size={12} />
            消耗明细
          </h4>
          {ledger.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-neutral-600">暂无流水记录</p>
          ) : (
            <ul className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
              {ledger.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/3 border border-white/6 text-[11px]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-neutral-300">
                      <span>{REASON_TEXT[item.reason] ?? item.reason}</span>
                      {item.model && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-white/6 text-neutral-500 truncate max-w-32">
                          {item.model}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-600 mt-0.5">{fmtTime(item.created_at)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`font-semibold tabular-nums ${
                        item.direction === 1 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {item.direction === 1 ? '+' : '-'}
                      {fmtTokens(item.amount)}
                    </div>
                    <div className="text-[9px] text-neutral-600 mt-0.5">
                      余额 {fmtTokens(item.balance_after)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
};

export default TokenModal;
