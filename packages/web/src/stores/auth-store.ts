import axios from 'axios';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import apiClient from '@/services/api-client';

/** 冻结契约：用户信息（字段名不得更改） */
export interface AuthUser {
  id: number | string;
  phone: string;
  nickname: string;
  avatar_url: string;
  created_at?: string;
  /** 账号角色：0 普通用户 / 1 运营 / 2 超管（任务 #49，旧数据可能缺省） */
  role?: number;
}

/** 运营后台可见性判定：role>=1 即具备后台权限（任务 #49） */
export function isAdmin(user: AuthUser | null): boolean {
  return !!user && (user.role ?? 0) >= 1;
}

interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

interface RegisterRequest {
  phone: string;
  code: string;
  password: string;
  nickname?: string;
  /** 协议勾选（v2 §9.2）：注册必须携带 agreed_terms=true */
  agreed_terms?: boolean;
}

interface LoginRequest {
  phone: string;
  /** 密码或验证码二选一 */
  password?: string;
  code?: string;
}

export type AuthStatus = 'checking' | 'authed' | 'guest';

interface AuthState {
  access_token: string | null;
  refresh_token: string | null;
  user: AuthUser | null;
  /** checking=启动校验中；authed=已登录；guest=未登录（渲染登录页） */
  status: AuthStatus;

  sendCode: (phone: string) => Promise<{ expires_in: number }>;
  register: (req: RegisterRequest) => Promise<void>;
  login: (req: LoginRequest) => Promise<void>;
  /** 刷新令牌；单飞（并发共享同一 promise）。成功返回 true 并更新双 token */
  refresh: () => Promise<boolean>;
  logout: () => Promise<void>;
  loadMe: () => Promise<void>;
}

/** 会话失败时的统一清理 */
function clearSession(): void {
  useAuthStore.setState({
    access_token: null,
    refresh_token: null,
    user: null,
    status: 'guest',
  });
}

/** 单飞 promise：并发 401 时只发起一次 refresh */
let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = useAuthStore.getState().refresh_token;
  if (!refreshToken) return false;
  try {
    // 直连 axios，绕过 apiClient 拦截器，避免 401 递归续期
    const resp = await axios.post('/api/v1/auth/refresh', {
      refresh_token: refreshToken,
    });
    const body = resp.data as { code: number; data?: AuthTokens };
    if (body?.code !== 200 || !body.data?.access_token) return false;
    useAuthStore.setState({
      access_token: body.data.access_token,
      refresh_token: body.data.refresh_token,
    });
    return true;
  } catch {
    return false;
  }
}

function applySession(session: AuthTokens & { user: AuthUser }): void {
  useAuthStore.setState({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    user: session.user,
    status: 'authed',
  });
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      access_token: null,
      refresh_token: null,
      user: null,
      status: 'checking',

      sendCode: async (phone) => {
        const data = (await apiClient.post('/auth/sms-code', { phone })) as unknown as {
          expires_in: number;
        };
        return data;
      },

      register: async (req) => {
        const data = (await apiClient.post('/auth/register', req)) as unknown as AuthTokens & {
          user: AuthUser;
        };
        applySession(data);
      },

      login: async (req) => {
        const data = (await apiClient.post('/auth/login', req)) as unknown as AuthTokens & {
          user: AuthUser;
        };
        applySession(data);
      },

      refresh: () => {
        if (!refreshInFlight) {
          refreshInFlight = doRefresh().finally(() => {
            refreshInFlight = null;
          });
        }
        return refreshInFlight;
      },

      logout: async () => {
        const token = get().access_token;
        if (token) {
          // 尽力通知后端失效令牌，失败不影响本地登出
          try {
            await apiClient.post('/auth/logout');
          } catch {
            // ignore
          }
        }
        clearSession();
      },

      loadMe: async () => {
        const data = (await apiClient.get('/auth/me')) as unknown as { user: AuthUser };
        set({ user: data.user });
      },
    }),
    {
      name: 'inkbloom-auth',
      partialize: (s) => ({
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        user: s.user,
      }),
    },
  ),
);

let initStarted = false;

/**
 * 启动鉴权引导：有 token 则调 /auth/me 校验；
 * 失败尝试 refresh 一次后重试；再失败则清空会话。
 */
export async function initAuth(): Promise<void> {
  if (initStarted) return;
  initStarted = true;

  const { access_token, refresh_token } = useAuthStore.getState();
  if (!access_token && !refresh_token) {
    useAuthStore.setState({ status: 'guest' });
    return;
  }

  const verify = async (): Promise<boolean> => {
    try {
      await useAuthStore.getState().loadMe();
      useAuthStore.setState({ status: 'authed' });
      return true;
    } catch {
      return false;
    }
  };

  if (await verify()) return;

  const refreshed = await useAuthStore.getState().refresh();
  if (refreshed && (await verify())) return;

  clearSession();
}
