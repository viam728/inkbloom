import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import Modal from '@/components/common/Modal';
import GalleryGrid from '@/components/gallery/GalleryGrid';
import { toast } from '@/components/common/Toast';
import { useGalleryStore } from '@/stores/gallery-store';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import type { GalleryImage } from '@/services/image-client';
import type { ImageScope } from '@/services/image-client';
import type { EditorVariant } from './TipTapEditor';

type Tab = 'upload' | 'gallery';

interface ImagePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** 目标编辑器实例：传入时直接插入；缺省走 inkbloom:insert-content 定向广播 */
  editor?: Editor | null;
  /** 编辑器变体：优先用于推导 scope；缺省时按 ui-store 角色推导 */
  variant?: EditorVariant;
}

function errMsg(e: unknown): string {
  const axiosMsg = (e as { response?: { data?: { message?: string } } })?.response?.data
    ?.message;
  if (axiosMsg) return axiosMsg;
  if (e instanceof Error && e.message) return e.message;
  return '上传失败，请稍后重试';
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * 图片选择弹窗：本地上传 / 图床选择双 Tab，底部提供 AI 生图跳转。
 * scope 推导：variant（novel|media|memo）优先，否则按角色 novelist→novel / media→media / memo→memo；
 * scope=novel 时附加当前作品 novel_id。
 */
const ImagePickerModal: React.FC<ImagePickerModalProps> = ({ open, onClose, editor, variant }) => {
  const role = useUIStore((s) => s.role);
  const currentNovel = useNovelStore((s) => s.currentNovel);

  const scope: ImageScope = variant ?? (role === 'media' ? 'media' : role === 'memo' ? 'memo' : 'novel');
  const novelId = scope === 'novel' ? currentNovel?.id : undefined;

  const [tab, setTab] = useState<Tab>('upload');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** 本次会话已上传缩略图（成功即插入） */
  const [uploadedIds, setUploadedIds] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const images = useGalleryStore((s) => s.images);

  // 打开时同步过滤条件（上传 scope 依赖）并重置本次会话缩略图
  useEffect(() => {
    if (!open) return;
    void useGalleryStore.getState().setFilter({ scope, novelId });
    setUploadedIds([]);
  }, [open, scope, novelId]);

  /** 插入图片：优先目标编辑器实例，否则走定向广播（最近聚焦编辑器接收） */
  const insertImage = (url: string, alt?: string) => {
    const safeUrl = escapeAttr(url);
    const safeAlt = escapeAttr(alt ?? '');
    if (editor && !editor.isDestroyed) {
      editor.chain().focus().insertContent({ type: 'image', attrs: { src: url, alt: alt ?? '' } }).run();
      return;
    }
    window.dispatchEvent(
      new CustomEvent('inkbloom:insert-content', {
        detail: { html: `<img src="${safeUrl}" alt="${safeAlt}" />` },
      }),
    );
  };

  /** 多文件逐个上传：成功立即插入并记入缩略图列表 */
  const handleFiles = async (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      toast.show('请选择图片文件', 'error');
      return;
    }
    setUploading(true);
    for (const file of files) {
      try {
        const item = await useGalleryStore.getState().upload(file);
        setUploadedIds((prev) => [item.id, ...prev]);
        insertImage(item.url, item.display_name);
      } catch (e) {
        toast.show(`${file.name}：${errMsg(e)}`, 'error');
      }
    }
    setUploading(false);
  };

  /** 图床选中项插入（GalleryGrid select 模式回调） */
  const insertSelected = (selected: GalleryImage[]) => {
    for (const img of selected) insertImage(img.url, img.display_name);
    toast.show(`已插入 ${selected.length} 张图片`, 'success');
    onClose();
  };

  const jumpToAIGC = () => {
    window.dispatchEvent(new CustomEvent('inkbloom:show-aigc'));
    onClose();
  };

  const uploadedImages = images.filter((i) => uploadedIds.includes(i.id));

  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={`flex-1 pb-2.5 text-xs font-medium tracking-widest transition-colors border-b-2 ${
        tab === t
          ? 'text-neutral-100 border-brand-500'
          : 'text-neutral-500 hover:text-neutral-300 border-transparent'
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <ImagePlus size={15} className="text-pink-400" />
          插入图片
        </span>
      }
      width="600px"
    >
      <div className="p-4 space-y-3">
        {/* Tab 切换 */}
        <div className="flex gap-4 px-1">
          {tabBtn('upload', '本地上传')}
          {tabBtn('gallery', '从图床选择')}
        </div>

        {tab === 'upload' && (
          <div className="space-y-3">
            {/* 拖拽上传区 */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-2 h-40 rounded-xl border border-dashed cursor-pointer transition-all ${
                dragOver
                  ? 'border-brand-500/70 bg-brand-500/10'
                  : 'border-white/12 bg-white/3 hover:bg-white/5 hover:border-white/20'
              }`}
            >
              {uploading ? (
                <LoaderCircle size={22} className="text-brand-400 animate-spin" />
              ) : (
                <UploadCloud size={22} className="text-neutral-500" />
              )}
              <p className="text-xs text-neutral-400">拖拽图片到此处，或点击选择文件</p>
              <p className="text-[10px] text-neutral-600">支持多文件，上传成功后立即插入</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            {/* 本次已上传缩略图 */}
            {uploadedImages.length > 0 && (
              <div className="grid grid-cols-6 gap-1.5">
                {uploadedImages.map((img) => (
                  <div key={img.id} className="relative aspect-square rounded-lg overflow-hidden border border-brand-500/40">
                    <img src={img.thumb_url || img.url} alt={img.display_name} className="w-full h-full object-cover" />
                    <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-brand-500 flex items-center justify-center">
                      <Check size={10} className="text-white" />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'gallery' && (
          <div className="h-[400px] flex flex-col rounded-xl border border-white/6 overflow-hidden">
            <GalleryGrid
              mode="select"
              initialFilter={{ scope, novelId }}
              onInsert={insertSelected}
            />
          </div>
        )}

        {/* AI 生图跳转 */}
        <button
          type="button"
          onClick={jumpToAIGC}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-fuchsia-500/25 hover:border-fuchsia-400/50 hover:bg-fuchsia-500/8 text-fuchsia-300 text-xs transition-all"
        >
          <Sparkles size={13} />
          没有合适的？用 AI 生成图片
          <span className="ml-auto text-[10px] text-neutral-600">跳转 AIGC 面板 →</span>
        </button>
      </div>
    </Modal>
  );
};

export default ImagePickerModal;
