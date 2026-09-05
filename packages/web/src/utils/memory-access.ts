import type { MemoryItem } from '@/stores/memory-store';

/**
 * 记忆 AI 访问闸门的前端镜像求值（备忘录：3 软闸 + 3 硬闸）。
 * 真正的注入过滤在服务端 agent_context.resolveMemoryItems——本模块仅用于
 * 展示侧（"注入设定"清单、线索库勾选等）与服务端保持同一套规则，两处
 * 语义必须同步修改。
 */

/** 闸门求值上下文：大纲节点 id → 1-based 大纲序（acts→nodes 展开序，与服务端/Python 端「第N章」编号一致） */
export interface AccessEvalContext {
  pos: Map<string, number>;
  title: Map<string, string>;
}

/** 由大纲 acts 构建（OutlineAct 结构以 nodes 数组为准，避免整库类型依赖） */
export function buildAccessEvalContext(acts: { nodes: { id: string; title?: string }[] }[]): AccessEvalContext {
  const pos = new Map<string, number>();
  const title = new Map<string, string>();
  let seq = 0;
  for (const act of acts) {
    for (const node of act.nodes) {
      seq += 1;
      pos.set(node.id, seq);
      title.set(node.id, node.title ?? '');
    }
  }
  return { pos, title };
}

/** 软闸求值结果：visible=无约束；ignore/hidden=注入但带约束指令 */
export type AccessState = 'visible' | 'ignore' | 'hidden';

export interface AccessVerdict {
  /** 是否进 AI 上下文（硬闸位置不符 = false） */
  inject: boolean;
  /** 软闸状态（硬闸不注入时无意义） */
  state: AccessState;
}

/**
 * 按写作位置（targetNodeId = 目标大纲节点）求值某条目的访问闸门。
 * 无写作位置（大纲生成/纯聊天等场景）时位置型闸门 fail-closed：硬闸不注入、
 * 软闸按 hidden 处理——与服务端一致，宁可保守不可剧透。
 */
export function evaluateAccess(item: MemoryItem, ctx: AccessEvalContext, targetNodeId?: string): AccessVerdict {
  const acc = item.ai_access;
  if (!acc?.mode) return { inject: true, state: 'visible' };
  const targetPos = targetNodeId ? (ctx.pos.get(targetNodeId) ?? 0) : 0;
  const hasTarget = targetPos > 0;
  const unlockPos = acc.unlock_chapter_id ? (ctx.pos.get(acc.unlock_chapter_id) ?? 0) : 0;
  const inSet = (ids?: string[]) => hasTarget && !!ids?.includes(targetNodeId!);
  switch (acc.mode) {
    case 'disabled':
      return { inject: false, state: 'visible' };
    case 'restricted_disabled':
      return hasTarget && unlockPos > 0 && targetPos >= unlockPos
        ? { inject: true, state: 'visible' }
        : { inject: false, state: 'visible' };
    case 'partial_disabled':
      return inSet(acc.visible_chapter_ids)
        ? { inject: true, state: 'visible' }
        : { inject: false, state: 'visible' };
    case 'ignore':
      return { inject: true, state: 'ignore' };
    case 'restricted_visible':
      return hasTarget && unlockPos > 0 && targetPos >= unlockPos
        ? { inject: true, state: 'visible' }
        : { inject: true, state: 'hidden' };
    case 'partial_visible':
      return inSet(acc.visible_chapter_ids)
        ? { inject: true, state: 'visible' }
        : { inject: true, state: 'hidden' };
    default:
      // 未知模式（契约演进容错）：按无限制处理，与服务端 default 分支一致
      return { inject: true, state: 'visible' };
  }
}

/** 条目列表上的权限徽标文案（静态描述，不依赖写作位置）；无限制返回 null */
export function describeAccess(item: MemoryItem): string | null {
  const acc = item.ai_access;
  if (!acc?.mode) {
    // 未迁移的旧数据兜底（normalizeMemoryItems 之外直接构造的条目）
    if (item.ai_visible === false) return 'AI 不可见';
    return null;
  }
  switch (acc.mode) {
    case 'ignore':
      return 'AI忽略';
    case 'restricted_visible':
      return '限制可见';
    case 'partial_visible':
      return '局部可见';
    case 'disabled':
      return 'AI禁用';
    case 'restricted_disabled':
      return '限制禁用';
    case 'partial_disabled':
      return '局部禁用';
    default:
      return null;
  }
}
