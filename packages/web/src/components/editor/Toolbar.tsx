import React from 'react';
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
  Activity,
  BarChart3,
  Lightbulb,
  MessageSquareQuote,
} from 'lucide-react';
import CopyMenu from '@/components/export/CopyMenu';
import { useUIStore } from '@/stores/ui-store';
import type { EditorVariant } from './TipTapEditor';

interface ToolbarProps {
  editor: Editor | null;
  onExport?: () => void;
  /** 编辑器变体：非小说模式隐藏章节相关的 AI 洞察入口 */
  variant?: EditorVariant;
  /** 导出按钮右侧的额外插槽（如自媒体模式的平台选择器） */
  afterExport?: React.ReactNode;
}

interface ToolbarButton {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  isActive?: () => boolean;
}

const iconCls = 'w-4 h-4';

const Toolbar: React.FC<ToolbarProps> = ({ editor, onExport, variant = 'novel', afterExport }) => {
  const isNovel = variant === 'novel';
  const setDashboardOpen = useUIStore((s) => s.setDashboardOpen);
  const setRhythmOpen = useUIStore((s) => s.setRhythmOpen);
  const setInspirationOpen = useUIStore((s) => s.setInspirationOpen);

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
            className={`${toolBtnCls} ${
              active
                ? '!bg-brand-600/25 !text-brand-300 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
                : ''
            }`}
          >
            {btn.icon}
          </button>
        );
      })}

      {/* Spacer + Export actions */}
      <div className="flex-1" />
      <div className="w-px h-4 bg-white/8 mx-1.5" />
      {/* AI 洞察入口（节奏图/批注评审依赖章节，仅小说模式） */}
      {isNovel && (
        <>
          <button
            type="button"
            onClick={() => setRhythmOpen(true)}
            className={`p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-indigo-300 active:scale-95`}
            title="剧情节奏图"
          >
            <Activity className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('inkbloom:show-review'))}
            className={`p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-orange-300 active:scale-95`}
            title="AI 批注评审"
          >
            <MessageSquareQuote className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setDashboardOpen(true)}
        className={`p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-emerald-300 active:scale-95`}
        title="写作仪表盘"
      >
        <BarChart3 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setInspirationOpen(true)}
        className={`p-1.5 rounded-md transition-all duration-150 text-neutral-400 hover:bg-white/8 hover:text-amber-300 active:scale-95`}
        title="灵感急救包"
      >
        <Lightbulb className="w-3.5 h-3.5" />
      </button>
      <div className="w-px h-4 bg-white/8 mx-1.5" />
      <button
        type="button"
        onClick={() => {
          // Switch right panel to AIGC tab by dispatching custom event
          window.dispatchEvent(new CustomEvent('inkbloom:show-aigc'));
        }}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${toolBtnCls}`}
        title="AI 图片生成"
      >
        <ImagePlus className="w-3.5 h-3.5 text-pink-400" />
        图片
      </button>
      <CopyMenu />
      {onExport && (
        <button
          type="button"
          onClick={onExport}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium ${toolBtnCls}`}
          title="导出"
        >
          <Download className="w-3.5 h-3.5" />
          导出
        </button>
      )}
      {afterExport}
    </div>
  );
};

export default Toolbar;
