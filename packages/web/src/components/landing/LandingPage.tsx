import React, { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Download,
  Flower2,
  Globe,
  LoaderCircle,
  Megaphone,
  Monitor,
  StickyNote,
  X,
} from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { useFlagsStore } from '@/stores/flags-store';

const DOWNLOAD_URL = '/api/v1/public/download/desktop';

/** 三种创作模式介绍 */
const MODES = [
  {
    icon: BookOpen,
    title: '小说创作',
    desc: '大纲驱动长篇写作，记忆与知识图谱让世界观始终自洽',
    accent: 'text-brand-300 bg-brand-500/12 border-brand-500/25',
  },
  {
    icon: Megaphone,
    title: '自媒体创作',
    desc: '选题池、内容库与人设立绘，从灵感到成稿一站完成',
    accent: 'text-pink-300 bg-pink-500/12 border-pink-500/25',
  },
  {
    icon: StickyNote,
    title: '简约随记',
    desc: '极简笔记界面，随手捕捉灵感碎片，零负担开写',
    accent: 'text-emerald-300 bg-emerald-500/12 border-emerald-500/25',
  },
];

/** 端功能差异对比（方案 1.4 口径） */
const DIFF_ROWS: {
  feature: string;
  desktop: { ok: boolean; note?: string };
  web: { ok: boolean; note?: string };
}[] = [
  { feature: '完整编辑功能', desktop: { ok: true }, web: { ok: true } },
  { feature: '离线可用', desktop: { ok: true }, web: { ok: false } },
  { feature: '云同步与多设备', desktop: { ok: false, note: '即将上线' }, web: { ok: true } },
  { feature: 'AI 能力（Token 计费）', desktop: { ok: true, note: '需联网' }, web: { ok: true } },
  { feature: '自动备份', desktop: { ok: true }, web: { ok: true } },
  { feature: '跨平台浏览器访问', desktop: { ok: false }, web: { ok: true } },
];

/** 差异单元格：✅/❌ + 备注 */
const DiffCell: React.FC<{ cell: { ok: boolean; note?: string } }> = ({ cell }) => (
  <div className="flex items-center justify-center gap-1.5">
    {cell.ok ? (
      <Check size={14} className="text-emerald-400" />
    ) : (
      <X size={14} className="text-rose-400/80" />
    )}
    {cell.note && <span className="text-[10px] text-amber-300/90">{cell.note}</span>}
  </div>
);

/** 多端安装引导落地页：guest 状态默认展示 */
const LandingPage: React.FC<{ onEnterAuth: () => void }> = ({ onEnterAuth }) => {
  const { showToast } = useToast();
  const desktopDownloadEnabled = useFlagsStore((s) => s.features.desktop_download);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // HEAD 预检：404 表示安装包尚未发布
      const resp = await fetch(DOWNLOAD_URL, { method: 'HEAD' });
      if (resp.status === 404) {
        showToast('安装包尚未发布', 'info');
        return;
      }
      if (!resp.ok) {
        showToast(`下载失败（${resp.status}）`, 'error');
        return;
      }
      window.open(DOWNLOAD_URL, '_blank');
    } catch {
      showToast('网络异常，请稍后重试', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const placeholderLink = (label: string) => (
    <button
      onClick={() => showToast('即将上线', 'info')}
      className="text-neutral-600 hover:text-neutral-400 transition-colors"
    >
      {label}
    </button>
  );

  return (
    <div className="relative h-screen w-full overflow-y-auto bg-surface-0 text-neutral-100">
      {/* ===== 氛围背景：光斑 + 噪点（与登录页同源） ===== */}
      <div aria-hidden className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-32 w-[560px] h-[560px] rounded-full bg-brand-600/20 blur-[130px] animate-bloom-drift" />
        <div className="absolute -bottom-48 right-[8%] w-[520px] h-[520px] rounded-full bg-pink-600/14 blur-[140px] animate-bloom-drift-slow" />
        <div className="absolute top-[30%] left-[52%] w-[320px] h-[320px] rounded-full bg-purple-600/10 blur-[110px]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%272%27/%3E%3C/filter%3E%3Crect width=%27160%27 height=%27160%27 filter=%27url(%23n)%27 opacity=%270.6%27/%3E%3C/svg%3E")',
          }}
        />
      </div>

      <div className="relative max-w-5xl mx-auto px-6 pb-12">
        {/* ===== 顶部导航 ===== */}
        <header className="flex items-center justify-between py-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <Flower2 size={17} className="text-white" />
            </div>
            <span className="font-display text-lg font-bold bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
              InkBloom
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <a
              href="/discover"
              className="px-4 py-1.5 rounded-xl text-xs font-medium text-neutral-300 border border-white/10 bg-white/4 hover:bg-white/8 hover:text-neutral-100 transition-colors"
            >
              浏览社区
            </a>
            <button
              onClick={onEnterAuth}
              className="px-4 py-1.5 rounded-xl text-xs font-medium text-neutral-300 border border-white/10 bg-white/4 hover:bg-white/8 hover:text-neutral-100 transition-colors"
            >
              登录 / 注册
            </button>
          </div>
        </header>

        {/* ===== 主视觉 ===== */}
        <section className="pt-16 pb-14 text-center animate-fade-in-slow">
          <p className="text-[11px] tracking-[0.5em] uppercase text-neutral-500 mb-5">
            AI Writing Studio
          </p>
          <h1 className="font-display text-6xl md:text-7xl font-black leading-tight bg-gradient-to-r from-indigo-200 via-purple-200 to-pink-200 bg-clip-text text-transparent">
            InkBloom
          </h1>
          <p className="font-display mt-4 text-xl text-neutral-400 tracking-wide">
            让每一个灵感，都落地生花
          </p>

          {/* 双入口主按钮 */}
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onEnterAuth}
              className="w-64 py-3 rounded-2xl text-sm font-semibold tracking-widest text-white
                bg-gradient-to-r from-indigo-500 via-brand-500 to-pink-500 bg-[length:200%_100%]
                hover:bg-right transition-all duration-300 shadow-lg shadow-indigo-500/25
                active:scale-[0.98] flex items-center justify-center gap-2"
            >
              进入网页版
              <ArrowRight size={15} />
            </button>
            {desktopDownloadEnabled && (
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="w-64 py-3 rounded-2xl text-sm font-semibold tracking-widest text-neutral-200
                  border border-white/12 bg-white/4 hover:bg-white/8 hover:border-white/20
                  transition-all duration-200 active:scale-[0.98] disabled:opacity-60
                  flex items-center justify-center gap-2"
              >
                {downloading ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <Download size={15} />
                )}
                下载 Windows 桌面端
              </button>
            )}
          </div>
        </section>

        {/* ===== 三模式介绍 ===== */}
        <section className="grid md:grid-cols-3 gap-4 mb-16">
          {MODES.map((m) => (
            <div
              key={m.title}
              className="glass-panel rounded-2xl p-5 hover:-translate-y-1 transition-transform duration-300"
            >
              <div
                className={`w-10 h-10 rounded-xl border flex items-center justify-center mb-3.5 ${m.accent}`}
              >
                <m.icon size={18} />
              </div>
              <h3 className="text-sm font-semibold text-neutral-100">{m.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">{m.desc}</p>
            </div>
          ))}
        </section>

        {/* ===== 端功能差异对比表 ===== */}
        <section className="mb-16">
          <h2 className="font-display text-center text-2xl font-bold text-neutral-200 mb-2">
            桌面端与网页版
          </h2>
          <p className="text-center text-xs text-neutral-500 mb-6">
            选择适合你的创作方式，数据随时属于你
          </p>
          <div className="glass-panel rounded-2xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/8 text-neutral-400">
                  <th className="text-left font-medium px-5 py-3.5 w-[40%]">功能</th>
                  <th className="font-medium px-4 py-3.5">
                    <span className="inline-flex items-center gap-1.5">
                      <Monitor size={13} className="text-brand-300" />
                      桌面端
                    </span>
                  </th>
                  <th className="font-medium px-4 py-3.5">
                    <span className="inline-flex items-center gap-1.5">
                      <Globe size={13} className="text-pink-300" />
                      Web 端
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {DIFF_ROWS.map((row, i) => (
                  <tr
                    key={row.feature}
                    className={`${i > 0 ? 'border-t border-white/5' : ''} text-neutral-300 hover:bg-white/3 transition-colors`}
                  >
                    <td className="px-5 py-3">{row.feature}</td>
                    <td className="px-4 py-3 text-center">
                      <DiffCell cell={row.desktop} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <DiffCell cell={row.web} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-center text-[10px] text-neutral-600">
            Web 端全部功能需登录使用，AI 能力按 Token 用量计费
          </p>
        </section>

        {/* ===== 底部占位链接 ===== */}
        <footer className="flex items-center justify-center gap-6 text-[11px] pb-4">
          {placeholderLink('用户协议')}
          <span className="text-neutral-800">·</span>
          {placeholderLink('隐私政策')}
          <span className="text-neutral-800">·</span>
          <span className="text-neutral-700">© 2026 InkBloom</span>
        </footer>
      </div>
    </div>
  );
};

export default LandingPage;
