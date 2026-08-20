import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload,
  CheckSquare,
  Images,
  Eye,
  Link2,
  Hash,
  Trash2,
  Loader2,
  X,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import { useToast } from '@/components/common/Toast';
import { useGalleryStore, type GalleryFilter } from '@/stores/gallery-store';
import { useNovelStore } from '@/stores/novel-store';
import type { GalleryImage, ImageScope } from '@/services/image-client';

/** 过滤键：全部 / 自媒体 / 随记 / 小说作品（下拉选具体作品） */
type FilterKey = 'all' | 'media' | 'memo' | 'novel';

const FILTER_TABS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'media', label: '自媒体' },
  { key: 'memo', label: '随记' },
  { key: 'novel', label: '小说作品' },
];

export interface GalleryGridProps {
  /** manage=完整管理能力；select=仅网格多选 + 底部插入确认 */
  mode: 'manage' | 'select';
  /** 紧凑布局：2-3 列网格，适配右栏 260-480px 宽度 */
  compact?: boolean;
  /** select 模式挂载时强制同步的过滤条件（如 ImagePicker 的 scope 推导） */
  initialFilter?: GalleryFilter;
  /** 可见性：为 false 时跳过补齐加载（RightPanel 未展开右栏等场景） */
  visible?: boolean;
  /** select 模式确认回调：回传选中条目，由宿主负责插入 */
  onInsert?: (images: GalleryImage[]) => void;
}

/** 从当前 store filter 反推激活的过滤键 */
function activeFilterKey(scope?: ImageScope): FilterKey {
  if (scope === 'media') return 'media';
  if (scope === 'memo') return 'memo';
  if (scope === 'novel') return 'novel';
  return 'all';
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 完整链接：相对路径拼接 origin，绝对地址原样返回 */
function fullLink(url: string): string {
  return /^https?:\/\//i.test(url) ? url : location.origin + url;
}

/** 相对路径：去掉 origin 前缀 */
function relPath(url: string): string {
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).pathname;
  } catch {
    /* ignore */
  }
  return url;
}

function isConflict(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 409;
}

function filterEq(a: GalleryFilter, b: GalleryFilter): boolean {
  return a.scope === b.scope && a.novelId === b.novelId;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const iconBtnCls =
  'p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/10 transition-colors';

/** 轻量预览 overlay：独立 portal + 高层级，避免被 Modal 栈遮挡 */
const PreviewOverlay: React.FC<{ image: GalleryImage; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[1095] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/8 hover:bg-white/16 text-neutral-300 hover:text-white transition-colors"
        title="关闭（Esc）"
      >
        <X size={16} />
      </button>
      <img
        src={fullLink(image.url)}
        alt={image.display_name}
        className="max-w-[88vw] max-h-[82vh] object-contain rounded-md animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-full bg-black/60 backdrop-blur text-[11px] text-neutral-300 whitespace-nowrap">
        <span className="max-w-[40vw] truncate text-neutral-200">{image.display_name}</span>
        <span className="text-neutral-500">·</span>
        <span>{image.width}×{image.height}</span>
        <span className="text-neutral-500">·</span>
        <span>{formatSize(image.file_size)}</span>
      </div>
    </div>,
    document.body,
  );
};

/**
 * 图床网格核心组件（任务 #66）：
 * - manage 模式：筛选 / 上传 / 预览 / 复制 / 单删与批量删除（含 409 强删）
 * - select 模式：仅网格多选 + 底部「插入选中 (N)」，无管理按钮
 * - 加载时机：挂载即 loadMore；visible 由隐藏转可见时补齐（loadMore 幂等，store epoch 防竞态）
 * - IntersectionObserver root 指向自身滚动容器，compact 下不依赖 viewport
 */
const GalleryGrid: React.FC<GalleryGridProps> = ({
  mode,
  compact = false,
  initialFilter,
  visible = true,
  onInsert,
}) => {
  const images = useGalleryStore((s) => s.images);
  const nextCursor = useGalleryStore((s) => s.nextCursor);
  const loading = useGalleryStore((s) => s.loading);
  const filter = useGalleryStore((s) => s.filter);
  const selection = useGalleryStore((s) => s.selection);
  const setFilter = useGalleryStore((s) => s.setFilter);
  const loadMore = useGalleryStore((s) => s.loadMore);
  const upload = useGalleryStore((s) => s.upload);
  const remove = useGalleryStore((s) => s.remove);
  const batchRemove = useGalleryStore((s) => s.batchRemove);
  const toggleSelect = useGalleryStore((s) => s.toggleSelect);
  const clearSelection = useGalleryStore((s) => s.clearSelection);

  const novels = useNovelStore((s) => s.novels);
  const fetchNovels = useNovelStore((s) => s.fetchNovels);
  const { showToast } = useToast();

  const [batchMode, setBatchMode] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<GalleryImage | null>(null);
  /** 单张删除确认目标 */
  const [confirmTarget, setConfirmTarget] = useState<GalleryImage | null>(null);
  /** 409 被引用 → 强删确认目标 */
  const [forceTarget, setForceTarget] = useState<GalleryImage | null>(null);
  /** 批量删除确认 */
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const isSelect = mode === 'select';
  const filterKey = activeFilterKey(filter.scope);
  const initialLoading = loading && images.length === 0;

  // select 模式：挂载时强制同步宿主过滤条件（在首载之前执行，setFilter 自带重载）
  useEffect(() => {
    if (!isSelect || !initialFilter) return;
    if (!filterEq(useGalleryStore.getState().filter, initialFilter)) {
      void setFilter(initialFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载修复：挂载即 loadMore（不再依赖外部开关）；visible 转真时补齐
  useEffect(() => {
    if (!visible) return;
    void loadMore();
    if (mode === 'manage' && novels.length === 0) void fetchNovels().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // select 模式：每次进入从空选择集开始，避免跨宿主残留
  useEffect(() => {
    if (isSelect) clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 底部哨兵：进入滚动容器可视区自动翻页（root 指向自身滚动容器，loadMore 幂等）
  useEffect(() => {
    if (!visible) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void loadMore();
      },
      { root: scrollRef.current, rootMargin: '160px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, loadMore]);

  const applyFilterTab = (key: FilterKey) => {
    if (key === filterKey && key !== 'novel') return;
    if (key === 'novel') {
      // 切到小说维度：默认选中当前筛选作品或第一部作品
      const target = filter.novelId ?? novels[0]?.id;
      if (target == null) {
        showToast('暂无小说作品可选', 'info');
        return;
      }
      void setFilter({ scope: 'novel', novelId: target });
    } else {
      void setFilter(key === 'all' ? {} : { scope: key });
    }
  };

  const handleNovelChange = (value: string) => {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0) void setFilter({ scope: 'novel', novelId: id });
  };

  /** compact 工具栏单一下拉的编码值：all/media/memo/novel:{id} */
  const filterSelectValue =
    filterKey === 'novel' ? `novel:${filter.novelId ?? ''}` : filterKey;

  const handleFilterSelect = (value: string) => {
    if (value.startsWith('novel:')) {
      const id = Number(value.slice(6));
      if (Number.isFinite(id) && id > 0) void setFilter({ scope: 'novel', novelId: id });
      else applyFilterTab('novel');
    } else if (value === 'all') {
      void setFilter({});
    } else {
      void setFilter({ scope: value as ImageScope });
    }
  };

  const handleUploadPick = async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    setUploading(true);
    let ok = 0;
    let fail = 0;
    for (const file of Array.from(files)) {
      try {
        await upload(file);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setUploading(false);
    if (ok > 0 && fail === 0) showToast(`已上传 ${ok} 张图片`, 'success');
    else if (ok > 0) showToast(`上传完成：成功 ${ok} 张，失败 ${fail} 张`, 'info');
    else showToast('上传失败，请检查后端服务', 'error');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCopyLink = async (img: GalleryImage) => {
    const ok = await copyText(fullLink(img.url));
    showToast(ok ? '已复制完整链接' : '复制失败', ok ? 'success' : 'error');
  };

  const handleCopyPath = async (img: GalleryImage) => {
    const ok = await copyText(relPath(img.url));
    showToast(ok ? '已复制相对路径' : '复制失败', ok ? 'success' : 'error');
  };

  const doDelete = async (img: GalleryImage, force = false) => {
    setBusy(true);
    try {
      await remove(img.id, force);
      showToast('已删除', 'success');
      setConfirmTarget(null);
      setForceTarget(null);
      if (preview?.id === img.id) setPreview(null);
    } catch (e) {
      if (!force && isConflict(e)) {
        // 409：图片被内容引用 → 询问强删
        setConfirmTarget(null);
        setForceTarget(img);
      } else {
        showToast('删除失败，请稍后重试', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const doBatchDelete = async () => {
    setBusy(true);
    try {
      const res = await batchRemove();
      if (res.deleted > 0) showToast(`已删除 ${res.deleted} 张图片`, 'success');
      if (res.skipped.length > 0) {
        showToast(`${res.skipped.length} 张因被内容引用而跳过`, 'info');
      }
      if (res.deleted === 0 && res.skipped.length === 0) showToast('没有可删除的选中项', 'info');
      setBatchConfirm(false);
    } catch {
      showToast('批量删除失败，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  };

  const selectAllVisible = () => {
    images.forEach((img) => {
      if (!selection.has(img.id)) toggleSelect(img.id);
    });
  };

  const copySelectedLinks = async () => {
    const selected = images.filter((img) => selection.has(img.id));
    if (selected.length === 0) return;
    const ok = await copyText(selected.map((img) => fullLink(img.url)).join('\n'));
    showToast(ok ? `已复制 ${selected.length} 条链接` : '复制失败', ok ? 'success' : 'error');
  };

  const confirmInsert = () => {
    const selected = images.filter((img) => selection.has(img.id));
    if (selected.length === 0) return;
    onInsert?.(selected);
    clearSelection();
  };

  const emptyState = !initialLoading && images.length === 0;
  /** 选择交互：select 模式恒为多选；manage 模式仅批量开关打开时多选 */
  const selecting = isSelect || batchMode;

  const gridCls = compact
    ? 'grid grid-cols-2 md:grid-cols-3 gap-2'
    : 'grid grid-cols-4 md:grid-cols-5 xl:grid-cols-6 gap-2.5';

  return (
    <div className="h-full flex flex-col text-neutral-300 min-h-0">
      {/* manage 模式工具栏 */}
      {mode === 'manage' && !compact && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/6 shrink-0">
          <div className="flex items-center gap-0.5 rounded-lg bg-white/4 p-0.5">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => applyFilterTab(tab.key)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                  filterKey === tab.key
                    ? 'bg-white/10 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <select
            value={filterKey === 'novel' ? String(filter.novelId ?? '') : ''}
            onChange={(e) => handleNovelChange(e.target.value)}
            onFocus={() => {
              if (filterKey !== 'novel') applyFilterTab('novel');
            }}
            className={`max-w-[180px] bg-transparent border border-white/8 rounded-md text-xs px-2 py-1.5 outline-none transition-colors ${
              filterKey === 'novel'
                ? 'text-neutral-200 border-white/16'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
            title="按小说作品筛选"
          >
            <option value="" disabled>
              选择作品…
            </option>
            {novels.map((n) => (
              <option key={n.id} value={n.id} className="bg-surface-1 text-neutral-200">
                {n.title}
              </option>
            ))}
          </select>

          <div className="flex-1" />

          <button
            onClick={() => {
              setBatchMode((v) => {
                if (v) clearSelection();
                return !v;
              });
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors ${
              batchMode
                ? 'border-brand-500/40 bg-brand-500/12 text-brand-300'
                : 'border-white/8 text-neutral-500 hover:text-neutral-300 hover:border-white/16'
            }`}
            title="批量选择模式"
          >
            <CheckSquare size={13} />
            批量
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-white/8 hover:bg-white/14 text-neutral-200 border border-white/8 transition-colors disabled:opacity-50"
            title="上传到当前筛选域"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            上传
          </button>
        </div>
      )}

      {/* manage 紧凑工具栏：单一下拉 + 图标按钮（右栏 260-480px） */}
      {mode === 'manage' && compact && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-white/6 shrink-0">
          <select
            value={filterSelectValue}
            onChange={(e) => handleFilterSelect(e.target.value)}
            className="flex-1 min-w-0 bg-surface-2 border border-white/8 rounded-md text-[11px] text-neutral-300 px-1.5 py-1 outline-none"
            title="筛选"
          >
            <option value="all">全部</option>
            <option value="media">自媒体</option>
            <option value="memo">随记</option>
            {novels.map((n) => (
              <option key={n.id} value={`novel:${n.id}`} className="bg-surface-1">
                {n.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              setBatchMode((v) => {
                if (v) clearSelection();
                return !v;
              });
            }}
            className={`p-1.5 rounded-md border transition-colors ${
              batchMode
                ? 'border-brand-500/40 bg-brand-500/12 text-brand-300'
                : 'border-white/8 text-neutral-500 hover:text-neutral-300'
            }`}
            title="批量选择模式"
          >
            <CheckSquare size={13} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="p-1.5 rounded-md border border-white/8 text-neutral-400 hover:text-neutral-200 transition-colors disabled:opacity-50"
            title="上传到当前筛选域"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          </button>
        </div>
      )}

      {/* manage 模式隐藏文件输入 */}
      {mode === 'manage' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void handleUploadPick(e.target.files)}
        />
      )}

      {/* 网格滚动区 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {initialLoading ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-500">
            <Loader2 size={20} className="animate-spin text-neutral-400" />
            <p className="text-xs">正在加载图床…</p>
          </div>
        ) : emptyState ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-4">
            <div
              className={`${
                compact ? 'w-11 h-11' : 'w-14 h-14'
              } rounded-2xl bg-white/4 border border-white/6 flex items-center justify-center`}
            >
              <Images size={compact ? 18 : 22} className="text-neutral-600" />
            </div>
            <p className="text-sm text-neutral-400">暂无图片</p>
            <p className="text-[11px] text-neutral-600 leading-relaxed text-center">
              {mode === 'manage' ? (
                <>
                  点击「上传」添加图片
                  <br />
                  AIGC 生成与编辑器插入的图片也会自动归集
                </>
              ) : (
                <>
                  图床暂无可选图片
                  <br />
                  可先在图床 Tab 或「本地上传」中上传
                </>
              )}
            </p>
          </div>
        ) : (
          <div className={compact ? 'px-2.5 py-2.5' : 'px-4 py-4'}>
            <div className={gridCls}>
              {images.map((img) => {
                const selected = selection.has(img.id);
                return (
                  <div
                    key={img.id}
                    className={`group relative aspect-square rounded-lg overflow-hidden bg-surface-2 border transition-colors cursor-pointer ${
                      selected ? 'border-brand-500/70' : 'border-white/6 hover:border-white/16'
                    }`}
                    onClick={() => {
                      if (selecting) toggleSelect(img.id);
                      else setPreview(img);
                    }}
                  >
                    <img
                      src={fullLink(img.thumb_url || img.url)}
                      alt={img.display_name}
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                    {/* 选择勾选指示 */}
                    {selecting && (
                      <span
                        className={`absolute top-1.5 left-1.5 w-[18px] h-[18px] rounded border flex items-center justify-center transition-colors ${
                          selected
                            ? 'bg-brand-500 border-brand-500 text-white'
                            : 'bg-black/40 border-white/40 backdrop-blur-sm'
                        }`}
                      >
                        {selected && <CheckSquare size={11} />}
                      </span>
                    )}
                    {/* 悬停浮层：元信息 + 操作（仅 manage 非批量时） */}
                    {!selecting && (
                      <div className="absolute inset-0 flex flex-col justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="flex justify-end gap-0.5 p-1.5 bg-gradient-to-b from-black/60 to-transparent">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreview(img);
                            }}
                            className={iconBtnCls}
                            title="预览大图"
                          >
                            <Eye size={13} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopyLink(img);
                            }}
                            className={iconBtnCls}
                            title="复制完整链接"
                          >
                            <Link2 size={13} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleCopyPath(img);
                            }}
                            className={iconBtnCls}
                            title="复制相对路径"
                          >
                            <Hash size={13} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmTarget(img);
                            }}
                            className="p-1 rounded-md text-neutral-500 hover:text-red-300 hover:bg-red-500/15 transition-colors"
                            title="删除"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <div
                          className={`${
                            compact ? 'px-2 pb-1.5 pt-5' : 'px-2.5 pb-2 pt-6'
                          } bg-gradient-to-t from-black/70 to-transparent`}
                        >
                          <p className={`${compact ? 'text-[10px]' : 'text-[11px]'} text-neutral-100 truncate`}>
                            {img.display_name}
                          </p>
                          <p className="text-[10px] text-neutral-400 truncate">
                            {img.width}×{img.height} · {formatSize(img.file_size)} ·{' '}
                            {formatDate(img.created_at)}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 分页哨兵 + 底部状态 */}
            <div ref={sentinelRef} className="h-px" />
            <div className="py-4 flex items-center justify-center text-[11px] text-neutral-600">
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" />
                  加载更多…
                </span>
              ) : images.length > 0 && !nextCursor ? (
                <span>已到底 · 共 {images.length} 张</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* manage 批量操作条 */}
      {mode === 'manage' && batchMode && (
        <div className="shrink-0 border-t border-white/6 bg-surface-1/95 backdrop-blur px-3 py-2 flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-neutral-400 pr-1">
            已选 <span className="text-neutral-100 font-medium">{selection.size}</span>
          </span>
          <button
            onClick={copySelectedLinks}
            disabled={selection.size === 0}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-neutral-300 hover:bg-white/8 disabled:opacity-40 transition-colors"
          >
            <Link2 size={12} />
            复制链接
          </button>
          <button
            onClick={selectAllVisible}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-neutral-300 hover:bg-white/8 transition-colors"
          >
            <CheckSquare size={12} />
            全选
          </button>
          <button
            onClick={() => setBatchConfirm(true)}
            disabled={selection.size === 0}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-red-300 hover:bg-red-500/15 disabled:opacity-40 transition-colors"
          >
            <Trash2 size={12} />
            删除
          </button>
          <button
            onClick={clearSelection}
            disabled={selection.size === 0}
            className="ml-auto px-2 py-1 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-white/8 disabled:opacity-40 transition-colors"
          >
            清除
          </button>
        </div>
      )}

      {/* select 模式底部确认条 */}
      {isSelect && (
        <div className="shrink-0 border-t border-white/6 px-3 py-2 flex items-center gap-2">
          <span className="text-[11px] text-neutral-500">
            已选 <span className="text-neutral-200 font-medium">{selection.size}</span> 张
          </span>
          {selection.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              清除
            </button>
          )}
          <button
            onClick={confirmInsert}
            disabled={selection.size === 0}
            className="ml-auto px-3.5 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-indigo-500 to-pink-500 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            插入选中（{selection.size}）
          </button>
        </div>
      )}

      {/* 大图预览 */}
      {preview && <PreviewOverlay image={preview} onClose={() => setPreview(null)} />}

      {/* 单张删除确认 */}
      <Modal
        open={confirmTarget !== null}
        onClose={() => !busy && setConfirmTarget(null)}
        title="删除图片"
        width="380px"
      >
        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-neutral-300">
            确定删除「{confirmTarget?.display_name}」吗？此操作不可撤销。
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmTarget(null)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/8 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => confirmTarget && void doDelete(confirmTarget)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-red-500/80 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              删除
            </button>
          </div>
        </div>
      </Modal>

      {/* 409 被引用 → 强删确认 */}
      <Modal
        open={forceTarget !== null}
        onClose={() => !busy && setForceTarget(null)}
        title="图片被引用"
        width="380px"
      >
        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-neutral-300 leading-relaxed">
            「{forceTarget?.display_name}」正被内容引用，普通删除已被阻止。是否强制删除？
            <span className="block mt-1 text-xs text-red-300/80">
              强删后引用该图的内容将无法显示图片。
            </span>
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setForceTarget(null)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/8 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => forceTarget && void doDelete(forceTarget, true)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-red-500/80 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              强制删除
            </button>
          </div>
        </div>
      </Modal>

      {/* 批量删除确认 */}
      <Modal
        open={batchConfirm}
        onClose={() => !busy && setBatchConfirm(false)}
        title="批量删除"
        width="380px"
      >
        <div className="px-4 py-4 space-y-4">
          <p className="text-sm text-neutral-300">
            确定删除选中的 {selection.size} 张图片吗？被内容引用的图片将自动跳过。
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setBatchConfirm(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/8 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={() => void doBatchDelete()}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-red-500/80 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              删除 {selection.size} 项
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default GalleryGrid;
