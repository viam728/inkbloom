import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { useAuthStore } from '@/stores/auth-store';
import { isDesktopShell } from '@/utils/platform';

/** 冻结契约：导入结果 created 各大类计数 */
export interface ImportCounts {
  novels: number;
  chapters: number;
  volumes: number;
  media_contents: number;
  media_topics: number;
  media_memory: number;
  knowledge_nodes: number;
  knowledge_edges: number;
  assets: number;
}

export interface ImportResult {
  created: ImportCounts;
  updated: number;
  conflicts: number;
  skipped: number;
  message: string;
}

/** created 各大类的中文展示名（按契约字段顺序） */
export const COUNT_LABELS: { key: keyof ImportCounts; label: string }[] = [
  { key: 'novels', label: '小说' },
  { key: 'chapters', label: '章节' },
  { key: 'volumes', label: '卷' },
  { key: 'media_contents', label: '媒体内容' },
  { key: 'media_topics', label: '选题' },
  { key: 'media_memory', label: '媒体记忆' },
  { key: 'knowledge_nodes', label: '知识节点' },
  { key: 'knowledge_edges', label: '知识关系' },
  { key: 'assets', label: '素材' },
];

/** 导入文件大小上限：500MB */
export const IMPORT_MAX_BYTES = 500 * 1024 * 1024;

/** 从 Content-Disposition 解析文件名（兼容 filename= 与 RFC5987 filename*=） */
function parseFilename(disposition: string): string | null {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() ?? null;
}

/** 兜底文件名：InkBloom-yyyyMMdd-HHmmss.inkbloom */
function fallbackFilename(): string {
  const d = new Date();
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `InkBloom-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.inkbloom`;
}

interface SyncState {
  exporting: boolean;
  importing: boolean;
  /** 云端双向同步进行中（桌面端，v2 §7.2） */
  cloudSyncing: boolean;
  lastResult: ImportResult | null;
  /** 导出全部数据为 .inkbloom 备份包并触发浏览器下载 */
  exportData: () => Promise<void>;
  /** 上传 .inkbloom 备份包导入 */
  importData: (file: File) => Promise<ImportResult>;
  /** 桌面端：本地数据上传到云端（本地 export → 云端 import） */
  uploadToCloud: () => Promise<ImportResult>;
  /** 桌面端：从云端拉取数据到本地（云端 export → 本地 import） */
  pullFromCloud: () => Promise<ImportResult>;
}

/** 云端 API 基址（桌面端跨端点同步用；默认同源，云端部署时由
 *  VITE_CLOUD_API_BASE 显式指向云端域名） */
function cloudAPIBase(): string {
  const override = import.meta.env.VITE_CLOUD_API_BASE as string | undefined;
  return override && override.trim() !== '' ? override.trim().replace(/\/$/, '') : '';
}

/** 桌面端跨端点请求云端（携带当前云端会话的 access token）。 */
async function cloudFetch(path: string, init: RequestInit): Promise<Response> {
  const token = useAuthStore.getState().access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${cloudAPIBase()}${path}`, { ...init, headers });
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  exporting: false,
  importing: false,
  cloudSyncing: false,
  lastResult: null,

  exportData: async () => {
    if (get().exporting) return;
    set({ exporting: true });
    try {
      // 原生 fetch 直取 zip 流，绕过 api-client 的 JSON 解包拦截器
      const token = useAuthStore.getState().access_token;
      const resp = await fetch('/api/v1/sync/export', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        let msg = `导出失败（${resp.status}）`;
        try {
          const body = (await resp.json()) as { message?: string };
          if (body?.message) msg = body.message;
        } catch {
          // 非 JSON 错误体，沿用默认提示
        }
        throw new Error(msg);
      }

      const blob = await resp.blob();
      const filename =
        parseFilename(resp.headers.get('Content-Disposition') ?? '') ?? fallbackFilename();

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      set({ exporting: false });
    }
  },

  importData: async (file) => {
    if (get().importing) throw new Error('导入进行中，请稍候');
    set({ importing: true });
    try {
      const form = new FormData();
      form.append('file', file);
      const data = (await apiClient.post('/sync/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })) as unknown as ImportResult;
      set({ lastResult: data });
      return data;
    } finally {
      set({ importing: false });
    }
  },

  uploadToCloud: async () => {
    if (!isDesktopShell()) throw new Error('仅桌面端支持云同步');
    if (get().cloudSyncing) throw new Error('同步进行中，请稍候');
    set({ cloudSyncing: true });
    try {
      // 1. 本地导出 .inkbloom（本地内嵌 server，同源）
      const localResp = await fetch('/api/v1/sync/export');
      if (!localResp.ok) throw new Error(`本地导出失败（${localResp.status}）`);
      const blob = await localResp.blob();

      // 2. 上传到云端 import（跨端点，携带云端会话）
      const form = new FormData();
      form.append('file', new File([blob], 'workspace.inkbloom', { type: 'application/zip' }));
      const resp = await cloudFetch('/api/v1/sync/import', { method: 'POST', body: form });
      const body = (await resp.json()) as { code?: number; message?: string; data?: ImportResult };
      if (!resp.ok || body.code !== 201 || !body.data) {
        throw new Error(body.message || `云端导入失败（${resp.status}）`);
      }
      set({ lastResult: body.data });
      return body.data;
    } finally {
      set({ cloudSyncing: false });
    }
  },

  pullFromCloud: async () => {
    if (!isDesktopShell()) throw new Error('仅桌面端支持云同步');
    if (get().cloudSyncing) throw new Error('同步进行中，请稍候');
    set({ cloudSyncing: true });
    try {
      // 1. 云端导出（跨端点，携带云端会话）
      const cloudResp = await cloudFetch('/api/v1/sync/export', { method: 'GET' });
      if (!cloudResp.ok) throw new Error(`云端导出失败（${cloudResp.status}）`);
      const blob = await cloudResp.blob();

      // 2. 本地导入（本地内嵌 server，同源）
      const form = new FormData();
      form.append('file', new File([blob], 'cloud.inkbloom', { type: 'application/zip' }));
      const data = (await apiClient.post('/sync/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })) as unknown as ImportResult;
      set({ lastResult: data });
      return data;
    } finally {
      set({ cloudSyncing: false });
    }
  },
}));
