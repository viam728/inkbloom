import { User, Map as MapIcon, ScrollText, Lightbulb, type LucideIcon } from 'lucide-react';
import type { MemoryType } from '@/stores/memory-store';

/** 结构化引导字段：轻量输入框 + placeholder 引导文案，值存 item.fields[key]，允许留空 */
export interface GuideField {
  key: string;
  label: string;
  placeholder: string;
}

/** 编辑弹窗内的 Tab 页：按分组声明可用集合 */
export type MemoryTab = 'profile' | 'relations' | 'detail' | 'portrait';

export const MEMORY_TAB_META: Record<MemoryTab, { label: string }> = {
  profile: { label: '基本资料' },
  relations: { label: '人物关系' },
  detail: { label: '详情' },
  portrait: { label: '立绘' },
};

export interface MemoryGroupConfig {
  label: string;
  icon: LucideIcon;
  /** 图标/标题着色 */
  color: string;
  /** 分组定位描述（用于提示文案） */
  description: string;
  /** 主体编辑区 placeholder */
  placeholder: string;
  /** 结构化引导字段定义 */
  fields: GuideField[];
  /** 该分组可用的编辑 Tab（弹窗按此渲染） */
  tabs: MemoryTab[];
}

/** 四分组配置：人物 / 设定 / 前情 / 灵感 */
export const GROUP_CONFIG: Record<MemoryType, MemoryGroupConfig> = {
  character: {
    label: '人物卡',
    icon: User,
    color: 'text-pink-300',
    description: '角色的长期档案，AI 对话与续写时保持人设一致',
    placeholder: '人物正文：经历、外貌细节、说话方式、关键剧情中的表现…',
    fields: [
      { key: 'brief', label: '简要描述', placeholder: '双击输入：她是谁？一句话概括这个角色…' },
      { key: 'appearance', label: '外貌特征', placeholder: '第一眼看到的印象：发型、眸色、身形、常穿的衣物…' },
      { key: 'background', label: '背景故事', placeholder: 'TA 从哪里来？过去发生过什么，如何走到今天…' },
      { key: 'personality', label: '性格特征', placeholder: '说话方式、待人态度，压力之下会怎样…' },
      { key: 'goal', label: '人物目标', placeholder: 'TA 最想要什么？愿意为此付出什么…' },
      { key: 'conflict', label: '内在冲突', placeholder: '内心撕扯的矛盾：责任与欲望、忠诚与背叛…' },
      { key: 'secret', label: '隐藏秘密', placeholder: '绝不轻易示人的事，揭晓时会改变什么…' },
      { key: 'weakness', label: '人物弱点', placeholder: '致命弱点或软肋：恐惧、旧伤、放不下的人…' },
      { key: 'attributes', label: '核心属性', placeholder: '能力/属性设定，如：剑术 A / 魔力 B / 口才 S' },
    ],
    tabs: ['profile', 'relations', 'detail', 'portrait'],
  },
  setting: {
    label: '设定集',
    icon: MapIcon,
    color: 'text-sky-300',
    description: '世界观与规则约束，防止 AI 生成内容违背设定',
    placeholder: '设定正文：补充说明、例外情况、已展示过的细节…',
    fields: [
      { key: 'worldview', label: '世界观', placeholder: '世界基本面貌，如：低魔奇幻 / 都市现实 / 星际' },
      { key: 'rules', label: '规则', placeholder: '力量体系 / 禁忌 / 运行逻辑，如：魔法需等价交换' },
      { key: 'places', label: '地点', placeholder: '重要地点与特征，如：北境雪城，终年不化' },
      { key: 'era', label: '时代', placeholder: '时代背景：科技水平、文化风貌' },
    ],
    tabs: ['profile', 'relations', 'detail', 'portrait'],
  },
  summary: {
    label: '前情摘要',
    icon: ScrollText,
    color: 'text-amber-300',
    description: '已发生的关键剧情，供后续章节保持连贯',
    placeholder: '前情正文：关键对白、遗留伏笔、尚未揭晓的信息…',
    fields: [
      { key: 'timeline', label: '时间线', placeholder: '事件时间脉络，如：三年前 — 宫变之夜' },
      { key: 'events', label: '事件摘要', placeholder: '关键事件及其造成的影响' },
    ],
    tabs: ['profile', 'detail'],
  },
  inspiration: {
    label: '灵感素材',
    icon: Lightbulb,
    color: 'text-violet-300',
    description: '随时干预 AI 的 tips：写作手法、桥段点子、希望 AI 遵守的规则',
    placeholder: '灵感正文：展开描述这个点子或手法的用法…',
    fields: [
      { key: 'trigger', label: '触发场景', placeholder: '这条 tip 在什么场景生效，如：写打斗戏时' },
      { key: 'tips', label: 'tip 要点', placeholder: '要点内容，如：对话保持短促有力，多用短句' },
    ],
    tabs: ['profile', 'detail'],
  },
};

/** 分组展示顺序 */
export const GROUP_ORDER: MemoryType[] = ['character', 'setting', 'summary', 'inspiration'];
