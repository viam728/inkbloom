import { create } from 'zustand';
import apiClient from '@/services/api-client';

/** 冻结契约：功能开关 */
export interface FeatureFlags {
  token_billing: boolean;
  desktop_download: boolean;
  feedback: boolean;
}

interface FlagsResponse {
  features: FeatureFlags;
  rollout_percent: number;
  server_version: string;
  /** 全局灰度总开关（可选）：false 时视为全部功能关闭 */
  enabled?: boolean;
}

const DEFAULT_FEATURES: FeatureFlags = {
  token_billing: true,
  desktop_download: true,
  feedback: true,
};

interface FlagsState {
  features: FeatureFlags;
  serverVersion: string;
  /** 是否已成功拉取过开关（未拉取时按默认全开） */
  loaded: boolean;
  fetchFlags: () => Promise<void>;
}

export const useFlagsStore = create<FlagsState>()((set) => ({
  features: DEFAULT_FEATURES,
  serverVersion: '',
  loaded: false,

  fetchFlags: async () => {
    const data = (await apiClient.get('/public/flags')) as unknown as FlagsResponse;
    const base = data?.features ?? DEFAULT_FEATURES;
    // 全局总开关关闭时，所有功能视为不可用
    const features: FeatureFlags =
      data?.enabled === false
        ? { token_billing: false, desktop_download: false, feedback: false }
        : { ...DEFAULT_FEATURES, ...base };
    set({ features, serverVersion: data?.server_version ?? '', loaded: true });
  },
}));
