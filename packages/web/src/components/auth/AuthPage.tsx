import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Flower2, LoaderCircle, PenLine, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { useToast } from '@/components/common/Toast';

type AuthTab = 'login' | 'register';
type LoginMode = 'password' | 'code';

const PHONE_RE = /^1[3-9]\d{9}$/;
/** ≥8 位且同时包含字母与数字 */
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '网络异常，请稍后重试';
}

/** 输入框：与深色玻璃体系一致的聚焦光环 */
const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <label className="block">
    <span className="flex items-baseline justify-between mb-1.5">
      <span className="text-[11px] tracking-[0.18em] text-neutral-400">{label}</span>
      {hint && <span className="text-[10px] text-neutral-600">{hint}</span>}
    </span>
    {children}
  </label>
);

const inputCls =
  'w-full bg-white/4 border border-white/8 rounded-xl px-3.5 py-2.5 text-sm text-neutral-100 ' +
  'placeholder:text-neutral-600 outline-none transition-all duration-200 ' +
  'focus:border-brand-500/60 focus:bg-white/6 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]';

const AuthPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { sendCode, login, register } = useAuthStore();
  const { showToast } = useToast();

  const [tab, setTab] = useState<AuthTab>('login');
  const [loginMode, setLoginMode] = useState<LoginMode>('password');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  // 表单字段
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  // 协议勾选（v2 §9.2）：注册前必须同意用户协议与隐私政策
  const [agreedTerms, setAgreedTerms] = useState(false);

  // 验证码倒计时（秒）
  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const phoneValid = PHONE_RE.test(phone);
  const passwordValid = PASSWORD_RE.test(password);

  const tabUnderline = useMemo(
    () => (tab === 'login' ? 'left-[12.5%]' : 'left-[62.5%]'),
    [tab],
  );

  const switchTab = (next: AuthTab) => {
    if (next === tab) return;
    setTab(next);
    setPassword('');
    setCode('');
  };

  const validatePhone = (): boolean => {
    if (!phoneValid) {
      showToast('请输入正确的手机号', 'error');
      return false;
    }
    return true;
  };

  const handleSendCode = async () => {
    if (countdown > 0 || sending) return;
    if (!validatePhone()) return;
    setSending(true);
    try {
      await sendCode(phone);
      showToast('验证码已发送，请注意查收短信', 'success');
      setCountdown(60);
    } catch (e) {
      showToast(errMsg(e), 'error');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!validatePhone()) return;

    if (tab === 'login') {
      if (loginMode === 'password') {
        if (!password) {
          showToast('请输入密码', 'error');
          return;
        }
      } else if (!code) {
        showToast('请输入验证码', 'error');
        return;
      }
    } else {
      if (!code) {
        showToast('请输入验证码', 'error');
        return;
      }
      if (!passwordValid) {
        showToast('密码需 ≥8 位且包含字母和数字', 'error');
        return;
      }
    }

    setLoading(true);
    try {
      if (tab === 'login') {
        await login(
          loginMode === 'password'
            ? { phone, password }
            : { phone, code },
        );
        showToast('欢迎回来 ✦', 'success');
      } else {
        // 协议勾选门槛（v2 §9.2）：未勾选禁止提交
        if (!agreedTerms) {
          showToast('请先阅读并同意用户协议与隐私政策', 'error');
          setLoading(false);
          return;
        }
        // 注册成功即自动登录（后端直接返回令牌）
        await register({
          phone,
          code,
          password,
          agreed_terms: true,
          ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        });
        showToast('注册成功，欢迎加入 InkBloom 🌸', 'success');
      }
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-surface-0 text-neutral-100 flex">
      {/* ===== 氛围背景：光斑 + 噪点 ===== */}
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-32 w-[560px] h-[560px] rounded-full bg-brand-600/20 blur-[130px] animate-bloom-drift" />
        <div className="absolute -bottom-48 right-[8%] w-[520px] h-[520px] rounded-full bg-pink-600/14 blur-[140px] animate-bloom-drift-slow" />
        <div className="absolute top-[38%] left-[46%] w-[300px] h-[300px] rounded-full bg-purple-600/10 blur-[110px]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%272%27/%3E%3C/filter%3E%3Crect width=%27160%27 height=%27160%27 filter=%27url(%23n)%27 opacity=%270.6%27/%3E%3C/svg%3E")',
          }}
        />
      </div>

      {/* 返回首页（由落地页进入时展示） */}
      {onBack && (
        <button
          onClick={onBack}
          className="absolute top-5 left-5 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/6 transition-colors animate-fade-in"
        >
          <ArrowLeft size={13} />
          返回首页
        </button>
      )}

      {/* ===== 品牌区 ===== */}
      <section className="relative hidden lg:flex flex-1 flex-col justify-center px-16 xl:px-24 animate-fade-in-slow">
        {/* 竖排签语 */}
        <div className="absolute right-10 top-1/2 -translate-y-1/2 flex items-center gap-3 text-neutral-600 select-none">
          <span className="text-[11px] tracking-[0.4em] [writing-mode:vertical-lr]">
            执笔之处 · 繁花自开
          </span>
          <span className="w-px h-28 bg-gradient-to-b from-transparent via-white/20 to-transparent" />
        </div>

        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Flower2 size={22} className="text-white" />
          </div>
          <span className="text-[11px] tracking-[0.5em] uppercase text-neutral-500">
            AI Writing Studio
          </span>
        </div>

        <h1 className="font-display text-[64px] xl:text-[76px] leading-[1.08] font-black bg-gradient-to-r from-indigo-200 via-purple-200 to-pink-200 bg-clip-text text-transparent">
          InkBloom
        </h1>
        <p className="font-display mt-3 text-xl text-neutral-400 tracking-wide">
          让每一个灵感，都落地生花
        </p>

        <ul className="mt-12 space-y-4 text-sm text-neutral-400">
          <li className="flex items-center gap-3">
            <Wand2 size={15} className="text-brand-400" />
            小说 · 自媒体 · 随记，三种创作场景随心切换
          </li>
          <li className="flex items-center gap-3">
            <Sparkles size={15} className="text-pink-400" />
            AI 续写、润色与立绘生成，全程陪跑
          </li>
          <li className="flex items-center gap-3">
            <ShieldCheck size={15} className="text-emerald-400" />
            记忆与大纲云端同步，灵感永不丢失
          </li>
        </ul>
      </section>

      {/* ===== 表单区 ===== */}
      <section className="relative flex items-center justify-center w-full lg:w-[520px] xl:w-[560px] shrink-0 px-5 lg:px-0">
        <div className="w-full max-w-[400px] animate-slide-up">
          {/* 小屏品牌标头 */}
          <div className="lg:hidden flex flex-col items-center mb-8">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30 mb-3">
              <Flower2 size={24} className="text-white" />
            </div>
            <h1 className="font-display text-3xl font-black bg-gradient-to-r from-indigo-200 via-purple-200 to-pink-200 bg-clip-text text-transparent">
              InkBloom
            </h1>
            <p className="mt-1 text-xs text-neutral-500">让每一个灵感，都落地生花</p>
          </div>

          <div className="glass-panel rounded-2xl p-7">
            {/* Tab 切换 */}
            <div className="relative flex mb-7 border-b border-white/8">
              {(['login', 'register'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchTab(t)}
                  className={`w-1/2 pb-3 text-sm font-medium tracking-widest transition-colors ${
                    tab === t ? 'text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {t === 'login' ? '登 录' : '注 册'}
                </button>
              ))}
              <span
                className={`absolute bottom-[-1px] w-1/4 h-[2px] rounded-full bg-gradient-to-r from-indigo-400 to-pink-400 transition-all duration-300 ${tabUnderline}`}
              />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="手机号">
                <input
                  className={inputCls}
                  type="tel"
                  maxLength={11}
                  placeholder="请输入 11 位手机号"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  autoComplete="tel"
                />
              </Field>

              {/* 登录 · 验证码模式 / 注册：验证码输入 */}
              {(tab === 'register' || loginMode === 'code') && (
                <Field label="短信验证码">
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="6 位验证码"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      autoComplete="one-time-code"
                    />
                    <button
                      type="button"
                      onClick={handleSendCode}
                      disabled={countdown > 0 || sending}
                      className="shrink-0 px-4 rounded-xl text-xs font-medium border transition-all duration-200
                        border-brand-500/30 text-brand-300 bg-brand-500/10
                        hover:bg-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {sending ? (
                        <LoaderCircle size={14} className="animate-spin" />
                      ) : countdown > 0 ? (
                        `${countdown}s 后重发`
                      ) : (
                        '获取验证码'
                      )}
                    </button>
                  </div>
                </Field>
              )}

              {/* 密码（登录密码模式 / 注册） */}
              {(tab === 'register' || loginMode === 'password') && (
                <Field
                  label="密码"
                  hint={tab === 'register' ? '≥8 位，含字母和数字' : undefined}
                >
                  <input
                    className={inputCls}
                    type="password"
                    placeholder={tab === 'register' ? '设置密码' : '请输入密码'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                  />
                </Field>
              )}

              {/* 注册：昵称（可选） */}
              {tab === 'register' && (
                <Field label="昵称" hint="选填">
                  <input
                    className={inputCls}
                    type="text"
                    maxLength={24}
                    placeholder="给自己起个名字"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    autoComplete="nickname"
                  />
                </Field>
              )}

              {/* 注册：协议勾选（v2 §9.2，未勾选禁止提交） */}
              {tab === 'register' && (
                <label className="flex items-start gap-2 text-[11px] leading-relaxed text-neutral-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={agreedTerms}
                    onChange={(e) => setAgreedTerms(e.target.checked)}
                    className="mt-0.5 w-3.5 h-3.5 rounded border-white/20 bg-white/6 accent-indigo-500"
                  />
                  <span>
                    我已阅读并同意
                    <a href="/legal/terms" target="_blank" rel="noreferrer" className="text-brand-300 hover:text-brand-200 mx-0.5">《用户协议》</a>
                    与
                    <a href="/legal/privacy" target="_blank" rel="noreferrer" className="text-brand-300 hover:text-brand-200 mx-0.5">《隐私政策》</a>
                    ，知晓创作内容将传输至模型服务商用于 AI 生成。
                  </span>
                </label>
              )}

              {/* 登录模式切换 */}
              {tab === 'login' && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setLoginMode((m) => (m === 'password' ? 'code' : 'password'))}
                    className="text-xs text-brand-300/90 hover:text-brand-200 transition-colors inline-flex items-center gap-1"
                  >
                    <PenLine size={12} />
                    {loginMode === 'password' ? '改用验证码登录' : '改用密码登录'}
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-2.5 rounded-xl text-sm font-semibold tracking-widest text-white
                  bg-gradient-to-r from-indigo-500 via-brand-500 to-pink-500 bg-[length:200%_100%]
                  hover:bg-right transition-all duration-300 shadow-lg shadow-indigo-500/25
                  active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed
                  flex items-center justify-center gap-2"
              >
                {loading && <LoaderCircle size={15} className="animate-spin" />}
                {tab === 'login' ? '进入创作' : '创建账号'}
              </button>
            </form>

            <p className="mt-5 text-center text-[11px] text-neutral-600 leading-relaxed">
              {tab === 'login' ? '还没有账号？' : '已有账号？'}
              <button
                type="button"
                onClick={() => switchTab(tab === 'login' ? 'register' : 'login')}
                className="text-brand-300 hover:text-brand-200 transition-colors ml-1"
              >
                {tab === 'login' ? '立即注册' : '去登录'}
              </button>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default AuthPage;
