import type { ReactNode } from 'react';
import { Wand2, Feather, PenLine, Lightbulb, ScrollText, Sparkles } from 'lucide-react';

/**
 * 对话内 Skill（Agent 快捷方式）注册表。
 *
 * 每个 Skill 是一条「给创作 Agent 的指令」——点击后直接把指令发给 Agent，
 * Agent 理解意图并调用工具（create_novel / create_chapter / write_chapter）
 * 完成实际创作。不是命令词预设、也不是页面跳转。
 *
 * 新增 Skill 只需在数组加一项。
 */

export interface ChatSkill {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  /** 发送给创作 Agent 的指令（Agent 会据此决定调用哪些工具） */
  prompt: string;
}

export const CHAT_SKILLS: ChatSkill[] = [
  {
    id: 'story',
    label: 'AI 起稿',
    description: '一句话创意，Agent 自动建书→分章→成稿',
    icon: <Wand2 size={15} />,
    prompt: '请帮我开始创作一部新小说：先根据我下面要说的创意创建作品，规划章节，再逐章撰写正文。我的创意是：',
  },
  {
    id: 'continue',
    label: '续写',
    description: '基于前文与设定续写下一段',
    icon: <Feather size={15} />,
    prompt: '请基于当前作品的前文与设定，续写接下来的内容。',
  },
  {
    id: 'polish',
    label: '润色',
    description: '优化文笔与表达，保持原意',
    icon: <PenLine size={15} />,
    prompt: '请润色下面这段文字：保持原意，优化文笔与表达。',
  },
  {
    id: 'inspiration',
    label: '灵感',
    description: '发散 3-5 条剧情桥段点子',
    icon: <Lightbulb size={15} />,
    prompt: '请结合当前作品，给出 3-5 条具体的剧情桥段灵感。',
  },
  {
    id: 'outline',
    label: '补大纲',
    description: '生成或补全幕/节点级情节规划',
    icon: <ScrollText size={15} />,
    prompt: '请生成或补全当前作品的大纲（幕/节点级情节规划）。',
  },
  {
    id: 'character',
    label: '造角色',
    description: '丰满一个人物的细节设定',
    icon: <Sparkles size={15} />,
    prompt: '请丰满这个角色的细节设定（外貌/性格/动机/说话方式）。',
  },
];
