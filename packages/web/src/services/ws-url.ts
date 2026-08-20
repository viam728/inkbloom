/**
 * WebSocket URL 构造（技术方案 v2 §3.1）。
 *
 * 规则：与页面同源 —— `{ws|wss}://{location.host}/ws?token={accessToken}`，
 * 协议随 location.protocol（https→wss）。这样：
 *  - 桌面端（页面由 http://127.0.0.1:18080 托管）→ ws://127.0.0.1:18080/ws
 *  - Web 云端（nginx 反代）→ wss://<domain>/ws
 *  - dev（vite :3000 代理 /ws 到 :8080）→ ws://localhost:3000/ws
 *
 * 可用 VITE_WS_URL 显式覆盖（开发联调 / API 域名分离部署场景）。
 */

/** buildWSURL 返回携带鉴权 token 的 WS 连接地址。
 *  token 为空（桌面端匿名本地会话，v2 §3.4）时不拼接 query。 */
export function buildWSURL(token: string): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  const base =
    override && override.trim() !== ''
      ? override.trim()
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  if (token === '') {
    return base;
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}
