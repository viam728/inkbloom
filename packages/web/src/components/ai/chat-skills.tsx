import type { ReactNode } from 'react';
import { Wand2, Sparkles, PenLine, Lightbulb, ScrollText, Feather } from 'lucide-react';

/**
 * 对话内 Skill（插件）注册表。
 *
 * 缺陷2 修复：把散落的 AI 能力收敛为「对话输入区 + 号菜单」里的可扩展 Skill。
 * 新增能力只需在下方 SKILLS 数组加一项，无需改动面板结构。
 *
 * kind 语义：
 *   - 'prompt'：把预置指令投递到输入框，用户可编辑后发送（如润色/续写/灵感）
 *   - 'navigate'：dispatch 一个窗口事件，切换/打开对应面板（如 AI 起稿）
 */

export type ChatSkillKind = 'prompt' | 'navigate';

export interface ChatSkill {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  kind: ChatSkillKind;
  /** kind='prompt'：投递到输入框的预置指令 */
  prompt?: string;
  /** kind='navigate'：dispatch 的窗口事件名 */
  event?: string;
}

export const CHAT_SKILLS: ChatSkill[] = [
  {
    id: 'story',
    label: 'AI 起稿',
    description: '一句话创意，自动跑完大纲→分章→成稿→落库',
    icon: <Wand2 size={15} />,
    kind: 'navigate',
    event: 'inkbloom:open-story-workflow',
  },
  {
    id: 'continue',
    label: '续写',
    description: '基于前文与设定续写下一段',
    icon: <Feather size={15} />,
    kind: 'prompt',
    prompt: '请基于当前章节前文与设定，续写接下来的内容。',
  },
  {
    id: 'polish',
    label: '润色',
    description: '优化文笔与表达，保持原意',
    icon: <PenLine size={15} />,
    kind: 'prompt',
    prompt: '请润色下面这段文字：保持原意，优化文笔与表达。',
  },
  {
    id: 'inspiration',
    label: '灵感',
    description: '发散 3-5 条剧情桥段点子',
    icon: <Lightbulb size={15} />,
    kind: 'prompt',
    prompt: '请结合当前作品，给出 3-5 条具体的剧情桥段灵感。',
  },
  {
    id: 'outline',
    label: '补大纲',
    description: '生成或补全幕/节点级情节规划',
    icon: <ScrollText size={15} />,
    kind: 'prompt',
    prompt: '请生成或补全当前作品的大纲（幕/节点级情节规划）。',
  },
  {
    id: 'character',
    label: '造角色',
    description: '丰满一个人物的细节设定',
    icon: <Sparkles size={15} />,
    kind: 'prompt',
    prompt: '请丰满这个角色的细节设定（外貌/性格/动机/说话方式）。',
  },
];
