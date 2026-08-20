/**
 * 标签工具：`#标签` 风格的解析与格式化
 */

/**
 * 按 `#` 拆分标签：trim、去空、去重，容忍前导 `#`。
 * 例：`"#主角 #反派"` 或 `"主角 #反派"` → `['主角', '反派']`
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of (raw ?? '').split('#')) {
    const tag = part.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** 输出 `#标签`（空格连接），空数组返回空串 */
export function formatTags(tags: string[]): string {
  return (tags ?? []).map((t) => `#${t}`).join(' ');
}
