import { create } from 'zustand';
import {
  uploadImage,
  listImages,
  deleteImage,
  batchDeleteImages,
  type GalleryImage,
  type ImageScope,
} from '@/services/image-client';

/** 图床过滤条件：scope 归属域 + 可选作品维度 */
export interface GalleryFilter {
  scope?: ImageScope;
  novelId?: number;
}

interface GalleryStore {
  images: GalleryImage[];
  nextCursor: string | null;
  loading: boolean;
  filter: GalleryFilter;
  selection: Set<number>;

  /** 切换过滤条件：清空列表并重载首页 */
  setFilter: (filter: GalleryFilter) => Promise<void>;
  /** 加载下一页（首页/已到底/加载中时安全幂等）；gen 为内部代次令牌，调用方勿传 */
  loadMore: (gen?: number) => Promise<void>;
  /** 上传文件并入列表头部（scope 取当前 filter）；失败抛出由调用方提示 */
  upload: (file: File) => Promise<GalleryImage>;
  /** 删除单张；409 被引用时抛出由调用方确认 force */
  remove: (id: number, force?: boolean) => Promise<void>;
  /** 批量删除当前选中项，返回 {deleted, skipped} */
  batchRemove: () => Promise<{ deleted: number; skipped: number[] }>;
  toggleSelect: (id: number) => void;
  clearSelection: () => void;
  reset: () => void;
}

const PAGE_SIZE = 24;

/** 代次令牌：每次 setFilter/reset 递增，使旧过滤条件的在途响应作废，避免污染新列表 */
let epoch = 0;

export const useGalleryStore = create<GalleryStore>((set, get) => ({
  images: [],
  nextCursor: null,
  loading: false,
  filter: {},
  selection: new Set<number>(),

  setFilter: async (filter) => {
    const my = ++epoch;
    set({ filter, images: [], nextCursor: null, selection: new Set() });
    await get().loadMore(my);
  },

  loadMore: async (gen) => {
    const my = gen ?? epoch;
    const { loading, images, nextCursor, filter } = get();
    // UI 触发的翻页在加载中时幂等返回；setFilter 携带新代次则强制发起（旧请求靠代次检查作废）
    if (loading && gen == null) return;
    // 已加载过且无游标 → 到底
    if (images.length > 0 && !nextCursor) return;
    set({ loading: true });
    try {
      const res = await listImages({
        scope: filter.scope,
        novelId: filter.novelId,
        limit: PAGE_SIZE,
        cursor: nextCursor ?? undefined,
      });
      // 旧代次响应：丢弃且不碰 loading（由新代次请求接管）
      if (my !== epoch) return;
      set((s) => ({
        images: [...s.images, ...(res.items ?? [])],
        nextCursor: res.next_cursor ?? null,
        loading: false,
      }));
    } catch {
      if (my !== epoch) return;
      set({ loading: false });
    }
  },

  upload: async (file) => {
    const { filter } = get();
    const res = await uploadImage(file, {
      scope: filter.scope ?? 'memo',
      novelId: filter.novelId,
    });
    const item: GalleryImage = {
      id: res.id,
      url: res.url,
      thumb_url: res.thumb_url,
      content_hash: res.content_hash,
      display_name: res.display_name,
      width: res.width,
      height: res.height,
      file_size: res.size,
      scope: res.scope,
      source: res.source,
      novel_id: filter.novelId ?? null,
      created_at: new Date().toISOString(),
    };
    set((s) => ({ images: [item, ...s.images.filter((i) => i.id !== item.id)] }));
    return item;
  },

  remove: async (id, force = false) => {
    await deleteImage(id, force);
    set((s) => {
      const selection = new Set(s.selection);
      selection.delete(id);
      return { images: s.images.filter((i) => i.id !== id), selection };
    });
  },

  batchRemove: async () => {
    const ids = Array.from(get().selection);
    if (ids.length === 0) return { deleted: 0, skipped: [] };
    const res = await batchDeleteImages(ids);
    const skippedSet = new Set(res.skipped ?? []);
    set((s) => ({
      // 保留未选中项与被跳过的被引用项
      images: s.images.filter((i) => !s.selection.has(i.id) || skippedSet.has(i.id)),
      selection: new Set(Array.from(s.selection).filter((id) => skippedSet.has(id))),
    }));
    return res;
  },

  toggleSelect: (id) =>
    set((s) => {
      const selection = new Set(s.selection);
      if (selection.has(id)) selection.delete(id);
      else selection.add(id);
      return { selection };
    }),

  clearSelection: () => set({ selection: new Set() }),

  reset: () => {
    epoch++;
    set({ images: [], nextCursor: null, loading: false, filter: {}, selection: new Set() });
  },
}));
