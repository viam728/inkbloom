import React, { useEffect, useRef } from 'react';
import {
  PenLine,
  Sparkles,
  ZoomIn,
  Scissors,
  MessagesSquare,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Minus,
  Code2,
  ImagePlus,
} from 'lucide-react';
import type { AIAction } from '@/services/ai-actions-client';

export type SlashItem =
  | { kind: 'ai'; action: AIAction; title: string; desc: string; icon: React.ReactNode; keywords: string }
  | { kind: 'format'; format: string; title: string; desc: string; icon: React.ReactNode; keywords: string }
  | { kind: 'image'; title: string; desc: string; icon: React.ReactNode; keywords: string };

/** 斜杠命令清单：AI 动作在前，格式块在后 */
export const SLASH_ITEMS: SlashItem[] = [
  {
    kind: 'ai',
    action: 'continue',
    title: 'AI 续写',
    desc: '基于上文生成多个候选走向',
    icon: <PenLine size={15} />,
    keywords: '续写 continue',
  },
  {
    kind: 'ai',
    action: 'polish',
    title: 'AI 润色',
    desc: '优化当前段落文字质感',
    icon: <Sparkles size={15} />,
    keywords: '润色 polish',
  },
  {
    kind: 'ai',
    action: 'expand',
    title: 'AI 扩写',
    desc: '扩展细节、氛围与心理描写',
    icon: <ZoomIn size={15} />,
    keywords: '扩写 expand',
  },
  {
    kind: 'ai',
    action: 'condense',
    title: 'AI 缩写',
    desc: '凝练表达，压缩冗余',
    icon: <Scissors size={15} />,
    keywords: '缩写 condense',
  },
  {
    kind: 'ai',
    action: 'dialogue',
    title: '续写对话',
    desc: '生成角色对白候选',
    icon: <MessagesSquare size={15} />,
    keywords: '对话 dialogue',
  },
  {
    kind: 'image',
    title: '图片',
    desc: '上传或从图床选择插入',
    icon: <ImagePlus size={15} />,
    keywords: '图片 image 上传 图床',
  },
  { kind: 'format', format: 'h1', title: '标题 1', desc: '一级标题', icon: <Heading1 size={15} />, keywords: 'h1 标题' },
  { kind: 'format', format: 'h2', title: '标题 2', desc: '二级标题', icon: <Heading2 size={15} />, keywords: 'h2 标题' },
  { kind: 'format', format: 'h3', title: '标题 3', desc: '三级标题', icon: <Heading3 size={15} />, keywords: 'h3 标题' },
  { kind: 'format', format: 'bullet', title: '无序列表', desc: '项目符号列表', icon: <List size={15} />, keywords: '列表 bullet' },
  { kind: 'format', format: 'ordered', title: '有序列表', desc: '编号列表', icon: <ListOrdered size={15} />, keywords: '列表 ordered' },
  { kind: 'format', format: 'quote', title: '引用', desc: '引用块', icon: <Quote size={15} />, keywords: '引用 quote' },
  { kind: 'format', format: 'code', title: '代码块', desc: '代码片段', icon: <Code2 size={15} />, keywords: '代码 code' },
  { kind: 'format', format: 'hr', title: '分割线', desc: '场景分隔', icon: <Minus size={15} />, keywords: '分割 hr divider' },
];

interface SlashCommandMenuProps {
  rect: DOMRect;
  items: SlashItem[];
  activeIndex: number;
  onSelect: (item: SlashItem) => void;
  onHover: (index: number) => void;
}

/** 编辑器内输入 / 弹出的命令菜单（Notion AI 风格） */
const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  rect,
  items,
  activeIndex,
  onSelect,
  onHover,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const MENU_H = 300;
  const openUp = rect.bottom + MENU_H > window.innerHeight;
  const left = Math.min(rect.left, window.innerWidth - 300);

  return (
    <div
      className="fixed z-40 glass-panel rounded-xl w-72 overflow-hidden animate-scale-in shadow-2xl shadow-black/40"
      style={
        openUp
          ? { left, bottom: window.innerHeight - rect.top + 6 }
          : { left, top: rect.bottom + 6 }
      }
    >
      <div className="px-3 py-1.5 border-b border-white/8 text-[10px] tracking-wider text-neutral-500 flex items-center gap-1.5">
        <Sparkles size={10} className="text-brand-400" />
        斜杠命令
      </div>
      <div ref={listRef} className="max-h-[260px] overflow-y-auto py-1">
        {items.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500 text-center">无匹配命令</div>
        )}
        {items.map((item, i) => (
          <button
            key={item.kind === 'ai' ? `ai-${item.action}` : item.kind === 'image' ? 'image' : `fmt-${item.format}`}
            onClick={() => onSelect(item)}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
              i === activeIndex ? 'bg-brand-600/20' : ''
            }`}
          >
            <span
              className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${
                item.kind === 'ai'
                  ? 'bg-gradient-to-br from-indigo-500/25 to-purple-500/25 text-brand-300'
                  : item.kind === 'image'
                    ? 'bg-gradient-to-br from-pink-500/25 to-fuchsia-500/25 text-pink-300'
                    : 'bg-white/5 text-neutral-400'
              }`}
            >
              {item.icon}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] text-neutral-200 leading-tight">{item.title}</span>
              <span className="block text-[11px] text-neutral-500 truncate">{item.desc}</span>
            </span>
            {item.kind === 'ai' && (
              <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/15 text-brand-300 border border-brand-500/25">
                N选1
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="px-3 py-1.5 border-t border-white/8 text-[10px] text-neutral-600 flex gap-3">
        <span>↑↓ 选择</span>
        <span>Enter 执行</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
};

export default SlashCommandMenu;
