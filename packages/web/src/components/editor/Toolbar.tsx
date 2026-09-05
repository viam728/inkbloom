import React, { useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Highlighter,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo2,
  Redo2,
  ImagePlus,
  Download,
  Maximize2,
  Minimize2,
  History,
} from 'lucide-react';
import ExportModal from '@/components/export/ExportModal';
import { putAutoSnapshot } from '@/utils/temp-branch';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import {
  useOutlineStore,
  OUTLINE_STATUS_LABELS,
  toggleWritingStatus,
  type OutlineNode,
  type OutlineStatus,
} from '@/stores/outline-store';
import type { MediaPlatform } from '@/types/media';
import type { EditorVariant } from './TipTapEditor';

interface ToolbarProps {
  editor: Editor | null;
  /** 编辑器变体：非小说模式隐藏章节相关的 AI 洞察入口 */
  variant?: EditorVariant;
  /** 自媒体模式：当前发布平台（统一导出弹窗内选择） */
  platform?: MediaPlatform;
  onSelectPlatform?: (id: MediaPlatform) => void;
  /** 自媒体模式：平台风格改写入口 */
  onAdapt?: () => Promise<void>;
  /** 工具栏预设：full = 完整右侧簇；plain = 仅纯文本格式化按钮（弹窗编辑器等精简场景） */
  preset?: 'full' | 'plain';
  /** 局部专注：是否提供受控专注开关（由宿主决定布局） */
  focusable?: boolean;
  /** 局部专注：当前是否处于专注态（受控，高亮展示） */
  focused?: boolean;
  /** 局部专注：切换回调（受控） */
  onToggleFocus?: () => void;
  /** 打开图片选择弹窗（仅 full 预设的「图片」按钮使用） */
  onOpenImagePicker?: () => void;
}

interface ToolbarButton {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  isActive?: () => boolean;
}

const iconCls = 'w-4 h-4';

/** 写作状态两态切换按钮配色（写作中/已完成用户可切，已发布系统管理） */
const STATUS_CHIP: Record<OutlineStatus, string> = {
  drafting: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
  done: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  published: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
};
const STATUS_DOT: Record<OutlineStatus, string> = {
  drafting: 'bg-amber-400',
  done: 'bg-emerald-400',
  published: 'bg-sky-400',
};

const Toolbar: React.FC<ToolbarProps> = ({ editor, variant = 'novel', platform, onSelectPlatform, onAdapt, preset = 'full', focusable, focused, onToggleFocus, onOpenImagePicker }) => {
  const isNovel = variant === 'novel';
  const isPlain = preset === 'plain';
  const [exportOpen, setExportOpen] = useState(false);
  const setHistoryOpen = useUIStore((s) => s.setHistoryOpen);
  const focusMode = useUIStore((s) => s.focusMode);
  const toggleFocusMode = useUIStore((s) => s.toggleFocusMode);

  // 当前章节绑定的大纲节点（写作状态切换按钮的数据源，仅小说模式）
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const outlineActs = useOutlineStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] : undefined,
  );
  let statusNode: { actId: string; node: OutlineNode } | null = null;
  if (isNovel && currentChapter && outlineActs) {
    for (const act of outlineActs) {
      const node = act.nodes.find((n) => n.chapter_id === currentChapter.id);
      if (node) {
        statusNode = { actId: act.id, node };
        break;
      }
    }
  }

  if (!editor) return null;

  const buttons: (ToolbarButton | 'separator')[] = [
    {
      label: '加粗',
      icon: <Bold className={iconCls} />,
      action: () => editor.chain().focus().toggleBold().run(),
      isActive: () => editor.isActive('bold'),
    },
    {
      label: '斜体',
      icon: <Italic className={iconCls} />,
      action: () => editor.chain().focus().toggleItalic().run(),
      isActive: () => editor.isActive('italic'),
    },
    {
      label: '下划线',
      icon: <Underline className={iconCls} />,
      action: () => editor.chain().focus().toggleUnderline().run(),
      isActive: () => editor.isActive('underline'),
    },
    {
      label: '高亮标记',
      icon: <Highlighter className={iconCls} />,
      action: () => editor.chain().focus().toggleHighlight().run(),
      isActive: () => editor.isActive('highlight'),
    },
    'separator',
    {
      label: '标题 1',
      icon: <Heading1 className={iconCls} />,
      action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      isActive: () => editor.isActive('heading', { level: 1 }),
    },
    {
      label: '标题 2',
      icon: <Heading2 className={iconCls} />,
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      isActive: () => editor.isActive('heading', { level: 2 }),
    },
    {
      label: '标题 3',
      icon: <Heading3 className={iconCls} />,
      action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      isActive: () => editor.isActive('heading', { level: 3 }),
    },
    'separator',
    {
      label: '无序列表',
      icon: <List className={iconCls} />,
      action: () => editor.chain().focus().toggleBulletList().run(),
      isActive: () => editor.isActive('bulletList'),
    },
    {
      label: '有序列表',
      icon: <ListOrdered className={iconCls} />,
      action: () => editor.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.isActive('orderedList'),
    },
    {
      label: '引用',
      icon: <Quote className={iconCls} />,
      action: () => editor.chain().focus().toggleBlockquote().run(),
      isActive: () => editor.isActive('blockquote'),
    },
    'separator',
    {
      label: '左对齐',
      icon: <AlignLeft className={iconCls} />,
      action: () => editor.chain().focus().setTextAlign('left').run(),
      isActive: () => editor.isActive({ textAlign: 'left' }),
    },
    {
      label: '居中对齐',
      icon: <AlignCenter className={iconCls} />,
      action: () => editor.chain().focus().setTextAlign('center').run(),
      isActive: () => editor.isActive({ textAlign: 'center' }),
    },
    {
      label: '右对齐',
      icon: <AlignRight className={iconCls} />,
      action: () => editor.chain().focus().setTextAlign('right').run(),
      isActive: () => editor.isActive({ textAlign: 'right' }),
    },
    'separator',
    {
      label: '撤销',
      icon: <Undo2 className={iconCls} />,
      action: () => editor.chain().focus().undo().run(),
    },
    {
      label: '重做',
      icon: <Redo2 className={iconCls} />,
      action: () => editor.chain().focus().redo().run(),
    },
  ];

  const toolBtnCls =
    'p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-neutral-100 active:scale-95';

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-white/6 bg-surface-1/60 backdrop-blur flex-wrap">
      {buttons.map((btn, i) => {
        if (btn === 'separator') {
          return <div key={`sep-${i}`} className="w-px h-4 bg-white/8 mx-1.5" />;
        }
        const active = btn.isActive?.() ?? false;
        return (
          <button
            key={btn.label}
            type="button"
            title={btn.label}
            onClick={btn.action}
                        className={`${toolBtnCls} ${active
                ? '!bg-brand-600/25 !text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
                : ''
            }`}
          >
            {btn.icon}
          </button>
        );
      })}

      {/* 局部专注受控入口（plain 与 full 预设通用，宿主传入时才渲染）；
          AIGC 统一为编辑器顶部配置卡片（备忘录 L61），工具栏不再渲染 Sparkles 入口 */}
      {focusable && onToggleFocus && (
        <>
          <div className="w-px h-4 bg-white/8 mx-1.5" />
          <button
            type="button"
            onClick={onToggleFocus}
            title={focused ? '退出局部专注' : '局部专注'}
                          className={`${toolBtnCls} ${focused
                ? '!bg-brand-600/25 !text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
                : ''
            }`}
          >
            {focused ? <Minimize2 className={iconCls} /> : <Maximize2 className={iconCls} />}
          </button>
        </>
      )}

      {/* Spacer + Export actions（plain 预设仅保留左侧格式化按钮，整体跳过右侧簇） */}
      {!isPlain && (
        <>
      <div className="flex-1" />
      <div className="w-px h-4 bg-white/8 mx-1.5" />
      {/* 版本历史（业务方案 v3 E1）：章节依赖，仅小说模式 */}
      {isNovel && (
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className={`p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-sky-300 active:scale-95`}
          title="版本历史"
        >
          <History className="w-3.5 h-3.5" />
        </button>
      )}
      {/* 节奏 / 批注 / 仪表盘 / 灵感包已迁移至右侧板（备忘录 L61）；
          AI 成章升级为编辑器顶部统一 AIGC 配置卡片；整本版本入口迁至全书概览页 */}
      <button
        type="button"
        onClick={() => {
          if (onOpenImagePicker) {
            onOpenImagePicker();
          } else {
            // 兼容：未接入选择弹窗时退化为跳转 AIGC 面板
            window.dispatchEvent(new CustomEvent('inkbloom:show-aigc'));
          }
        }}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${toolBtnCls}`}
        title="插入图片（上传 / 图床 / AI 生成）"
      >
        <ImagePlus className="w-3.5 h-3.5 text-pink-400" />
        图片
      </button>
      {/* 全局专注模式：进入/退出（Esc 退出由编辑器内核承担） */}
      <button
        type="button"
        onClick={toggleFocusMode}
        title={focusMode ? '退出专注模式 (Esc)' : '进入专注模式'}
                        className={`p-1.5 rounded-md transition-all duration-150 hover:bg-white/8 active:scale-95 ${focusMode ? '!bg-brand-600/25 !text-brand-300' : 'text-neutral-400 hover:text-neutral-100'
        }`}
      >
        {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
      {/* 统一"导出"入口：复制 / 导出 / 平台选择均在弹窗内完成 */}
      <button
        type="button"
        onClick={() => setExportOpen(true)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium ${toolBtnCls}`}
        title="导出 / 复制 / 平台"
      >
        <Download className="w-3.5 h-3.5" />
        导出
      </button>
      {/* 写作状态两态切换（写作中 ↔ 已完成）：与发布态解耦（备忘录 L61），
          发布只写完成标记、不再锁定状态位；发布入口在概览页发布管理。
          切到「已完成」时自动把当前正文存入工作区自动快照（浏览器本地）。 */}
      {isNovel && statusNode && (
        <button
          type="button"
          onClick={() => {
            if (!currentNovel || !statusNode) return;
            const nextStatus = toggleWritingStatus(statusNode.node.status);
            if (nextStatus === 'done' && editor && currentChapter) {
              const html = editor.getHTML();
              if (html.trim()) putAutoSnapshot(currentChapter.id, html, '点击已完成');
            }
            useOutlineStore.getState().updateNode(currentNovel.id, statusNode.actId, statusNode.node.id, {
              status: nextStatus,
            });
          }}
          title="切换写作状态（写作中 ↔ 已完成）"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-all ${
            STATUS_CHIP[statusNode.node.status === 'published' ? 'done' : statusNode.node.status]
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              STATUS_DOT[statusNode.node.status === 'published' ? 'done' : statusNode.node.status]
            }`}
          />
          {OUTLINE_STATUS_LABELS[
            statusNode.node.status === 'published' ? 'done' : statusNode.node.status
          ]}
        </button>
      )}
      {/* 发布入口已迁移至作品概览页（NovelOverview 操作区）：发布操作与读者看板统一在概览页 */}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        editor={editor}
        variant={variant}
        platform={platform}
        onSelectPlatform={onSelectPlatform}
        onAdapt={onAdapt}
      />
        </>
      )}
    </div>
  );
};

export default Toolbar;

