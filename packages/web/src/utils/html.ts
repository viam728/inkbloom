/**
 * HTML 工具
 */

/**
 * HTML 转义：将用户文本安全嵌入 HTML 片段（防注入）。
 */
export function escapeHtml(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * HTML → 纯文本：优先 DOMParser 提取 textContent，异常时正则兜底。
 * 空输入安全返回空串；不含标签的纯文本原样返回。
 */
export function htmlToPlainText(html: string): string {
  const src = html ?? '';
  if (!src.trim()) return '';
  // 不含任何标签视为纯文本，安全直返
  if (!/<[a-z!/][^>]*>/i.test(src)) return src;
  try {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    return (doc.body.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  } catch {
    return src
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
