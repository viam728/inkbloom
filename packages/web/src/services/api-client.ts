import axios, { type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/auth-store';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/components/common/Toast';

/** 附加到请求配置上的鉴权控制标记 */
interface AuthAwareConfig extends InternalAxiosRequestConfig {
  /** 401 续期后重放的请求，避免二次 401 导致无限续期 */
  _authRetried?: boolean;
  /** 跳过 401 自动续期（鉴权自身接口，如 /auth/logout） */
  _skipAuthRetry?: boolean;
}

/** 402 提醒节流：并发写请求同时 402 时只提示一次 */
let last402At = 0;

function notifyPaymentRequired(message: string): void {
  const now = Date.now();
  if (now - last402At < 3000) return;
  last402At = now;
  toast.show(message, 'error');
  // 按 message 分流引导：Token 余额不足开充值弹窗，否则开订阅弹窗
  if (message.includes('Token')) {
    useUIStore.getState().setTokenOpen(true);
  } else {
    useUIStore.getState().setSubscriptionOpen(true);
  }
}

// 注意：不得在实例级默认设置 Content-Type。axios transformRequest 见到
// application/json 头时会把 FormData 序列化成 JSON 字符串发送，导致后端
// 解析不出 multipart 字段（图床上传 400 根因）；JSON 请求的 Content-Type
// 由 axios 默认 transformRequest 自动设置，不受影响。
const apiClient = axios.create({
  baseURL: '/api/v1',
});

// 请求拦截器：注入 Bearer access_token
apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：解包 APIResponse + 401 单飞续期重放
apiClient.interceptors.response.use(
  (response) => {
    const body = response.data as { code?: number; message?: string; data?: unknown } | undefined;
    // APIResponse 包裹：code≠200 即业务错误，message 可直接 toast
    if (body && typeof body === 'object' && 'code' in body && body.code !== 200) {
      return Promise.reject(new Error(body.message || '请求失败')) as Promise<never>;
    }
    // 解包 data 后直接返回（与历史行为一致，调用方自行断言类型）
    const value = body && typeof body === 'object' && 'data' in body ? body.data : body;
    return value as never;
  },
  async (error) => {
    const status: number | undefined = error.response?.status;
    const config = error.config as AuthAwareConfig | undefined;
    const url: string = config?.url ?? '';

    // 订阅到期只读：提示 + 引导续费，不重放、不干扰 401 续期
    if (status === 402) {
      const msg =
        error.response?.data?.message || '订阅已到期，请续费后继续创作';
      notifyPaymentRequired(msg);
      return Promise.reject(error);
    }

    const isAuthEndpoint = url.startsWith('/auth/');

    if (status === 401 && config && !config._authRetried && !config._skipAuthRetry && !isAuthEndpoint) {
      // 并发 401 共享同一次 refresh（单飞 promise）
      const refreshed = await useAuthStore.getState().refresh();
      if (refreshed) {
        const retryConfig: AuthAwareConfig = {
          ...config,
          _authRetried: true,
        };
        retryConfig.headers.Authorization = `Bearer ${useAuthStore.getState().access_token}`;
        return apiClient(retryConfig);
      }
      // 续期失败：清空会话，App 依据 status 条件渲染回到登录页
      useAuthStore.setState({
        access_token: null,
        refresh_token: null,
        user: null,
        status: 'guest',
      });
    }

    const msg = error.response?.data?.message || error.message;
    console.error('[API Error]', msg);
    return Promise.reject(error);
  },
);

export default apiClient;
