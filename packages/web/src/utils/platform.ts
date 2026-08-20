/**
 * 运行环境探测（技术方案 v2 §3.4）。
 *
 * 桌面端（Electron 壳）通过 preload 注入 window.electronAPI；
 * Web 端（浏览器直接访问）无此对象。
 */

/** isDesktopShell 报告当前页面是否运行在 Electron 桌面壳内。 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}
