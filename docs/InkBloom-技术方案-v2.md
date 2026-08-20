# InkBloom — 技术方案（v2 · Web/Desktop 上线施工版）

> 🎯 目标：在 v1（自媒体 AIGC 图文工具技术方案）与《产品商业化方案》（M1–M6 已实施）基础上，**补齐 Web 端与 Desktop 端真实上线所需的技术与功能缺口**，形成可直接派发给 Agent 施工的清单。
>
> 📐 文档定位：**施工任务书**。每一项缺口均给出：现状证据（文件/代码位置）→ 缺口说明 → 施工内容 → 涉及文件 → 验收标准。
>
> ⏱ 文档时间：2026-08-20
>
> ✅ **施工状态（2026-08-20 终审更新）**：W1/W2/W3/W5/W6/W7 已交付并通过 API 工程验收（go build/test、pnpm build/typecheck、curl 冒烟全绿）。**G1–G9、G12–G18、G20 共 17 项已闭环**；G10（真实支付）、G11（真实短信）因需企业商户/渠道资质未施工（接入点已就绪）；G19（多平台构建）需证书与 CI 环境。
> 
> 终审补充：G8 已补 `packages/server/config.yaml.example`；G14 修复 Windows 下延迟恢复导致数据库损坏的问题（启动恢复前清理旧 live DB 的 WAL/SHM 文件）；G15 已补 `ai-service` `/metrics`（prometheus-fastapi-instrumentator）；G9 WS 鉴权当前使用 query token + Origin 白名单，`Sec-WebSocket-Protocol` 子协议可作为下一版本硬化项；G20 Lighthouse 性能跑分属于浏览器级 UI 验收，本次按用户要求跳过。

---

## 目录

1. [上线形态总览](#1-上线形态总览)
2. [缺口总表（优先级矩阵）](#2-缺口总表优先级矩阵)
3. [P0-A 桌面端阻断性缺陷修复](#3-p0-a-桌面端阻断性缺陷修复)
4. [P0-B Web 端部署与接入修复](#4-p0-b-web-端部署与接入修复)
5. [P1 云端安全与合规基线](#5-p1-云端安全与合规基线)
6. [P1 商业化闭环（真实支付/短信）](#6-p1-商业化闭环真实支付短信)
7. [P1 桌面端产品化（更新/备份/云同步入口）](#7-p1-桌面端产品化更新备份云同步入口)
8. [P2 可观测性与运维](#8-p2-可观测性与运维)
9. [P2 内容安全与协议合规](#9-p2-内容安全与协议合规)
10. [P3 体验与功能完善](#10-p3-体验与功能完善)
11. [施工里程碑](#11-施工里程碑)
12. [全局验收清单](#12-全局验收清单)

---

## 1. 上线形态总览

```
┌────────────────────────────────────────────────────────────────────┐
│  Web 端（云端 SaaS）                                                │
│  用户浏览器 → CDN/对象存储(静态站点) 或 nginx(web 容器)               │
│      → https://api.<domain>/api/v1/*  (Go server, cloud mode)      │
│      → wss://api.<domain>/ws         (WebSocket)                   │
│  强制登录（JWT），数据存云端 PostgreSQL。                            │
│                                                                    │
│  Desktop 端（免费离线 + 云端增强）                                   │
│  Electron 安装包（NSIS）                                            │
│    ├─ 内嵌 Go server（local mode: SQLite + 内存 kv + NoopNATS）     │
│    ├─ 监听 127.0.0.1:18080，托管 web dist（SPA）                   │
│    ├─ 离线免登录可用全部创作功能                                    │
│    └─ AI/云同步需联网登录云端账号 → 直连云端 api.<domain>           │
│                                                                    │
│  云端服务（docker-compose 起步，可平滑上云）                         │
│    server(:8080) / ai-service(:8100) / postgres / redis / nats     │
└────────────────────────────────────────────────────────────────────┘
```

**已确认现状（代码证据）**：
- M1–M6 已落地：JWT 账户体系（`middleware/auth_jwt.go`）、全表 user_id 隔离、订阅状态机（`service/subscription_service.go`）、Token 计费（`service/token_service.go`）、`.inkbloom` 导入导出（`service/sync_*.go`）、运营后台（`handler/admin_handler.go`）、落地页与灰度 flags（`handler/public_handler.go`）。
- 桌面端骨架完整：内嵌 server 生命周期（`desktop/electron/server-manager.ts`）、备份调度（`desktop/electron/backup.ts`）、NSIS 打包（`desktop/electron-builder.yml`）。
- **支付/短信为占位**：`pkg/payment/provider.go` 中 alipay/wechat 返回 `ErrChannelUnavailable`；`pkg/sms/provider.go` 的 ProdProvider 未实现。
- **无全站限流**：middleware 目录无 ratelimit（仅短信验证码有 60s 单点限制 `auth_service.go:121`）。

---

## 2. 缺口总表（优先级矩阵）

| # | 优先级 | 缺口 | 影响端 | 章节 |
|---|--------|------|--------|------|
| G1 | **P0** | 前端 WS 地址硬编码 `:8080`，桌面端（18080）与云端（443/wss）均连不上 WS | desktop + web | 3.1 |
| G2 | **P0** | 桌面端 local 模式无 NATS，AIGC 任务事件链断裂（NoopNATSPublisher 丢弃事件，前端任务进度永不更新） | desktop | 3.2 |
| G3 | **P0** | 任务引擎在 local 模式 `distLock=nil` 直接 panic（`engine.go:211` 调用 `e.lock.Acquire`） | desktop | 3.3 |
| G4 | **P0** | Web 端云端部署缺 WS 相对路径与 wss 支持；nginx 已配 `/ws` 但前端写死端口 | web | 4.1 |
| G5 | **P0** | CORS 白名单仅 localhost，生产域名无法跨域；桌面端 file:// 或 127.0.0.1 Origin 未覆盖 | web + desktop | 4.2 |
| G6 | **P0** | 桌面端未登录时 `GetUserID(c)=0`，本地库所有数据 user_id=0 与云端演示账号(id=1) 语义冲突；且本地多账号/云端拉取无归属方案 | desktop | 3.4 |
| G7 | **P1** | 无全站 API 限流/防刷（注册、短信、AI 接口裸奔） | web | 5.1 |
| G8 | **P1** | JWT secret 有默认值且 config.yaml 明文提交；`.env.example` 泄漏真实 OpenAI key 样式 | web | 5.2 |
| G9 | **P1** | WS 鉴权用 query 明文 token；CheckOrigin 恒 true | web | 5.3 |
| G10 | **P1** | 真实支付（支付宝/微信 Native）未接入，sandbox 直接到账 | web | 6.1 |
| G11 | **P1** | 真实短信通道未接入（DevProvider 打日志） | web | 6.2 |
| G12 | **P1** | 桌面端自动更新 feed 为 placeholder URL | desktop | 7.1 |
| G13 | **P1** | 桌面端「云同步」菜单为 disabled 占位，本地→云端首次导入无 UI 入口 | desktop | 7.2 |
| G14 | **P1** | 桌面端备份仅 DB 快照，assets 素材目录未纳入备份 | desktop | 7.3 |
| G15 | **P2** | 无 Prometheus /metrics、无结构化访问日志采样、无告警 | web | 8.1 |
| G16 | **P2** | AIGC 输入输出未过内容安全网关（合规硬要求） | web | 9.1 |
| G17 | **P2** | 用户协议/隐私政策/算法备案占位缺失 | web | 9.2 |
| G18 | **P2** | SSE 流式 AI 端点（/ai/chat、/ai/inline、/ai/rewrite）未计费 | web | 6.3 |
| G19 | **P3** | 桌面端仅 Windows x64，无 macOS/Linux 构建与签名 | desktop | 10.1 |
| G20 | **P3** | Web 端无 E2E 冒烟与性能预算（Lighthouse/包体积） | web | 10.2 |

---

## 3. P0-A 桌面端阻断性缺陷修复

> 目标：桌面端安装包开箱即用，离线创作全链路（含 AIGC 任务进度）可用。

### 3.1 G1 — WS 地址硬编码修复

**现状证据**：`packages/web/src/App.tsx:36`
```ts
const wsUrl = `ws://${window.location.hostname}:8080/ws?token=...`;
```
- 桌面端页面由 `http://127.0.0.1:18080` 托管，WS 应连 `ws://127.0.0.1:18080/ws`；
- Web 云端经 nginx 反向代理，WS 应连 `wss://<host>/ws`（同源相对路径）。

**施工内容**：
1. 新增 `packages/web/src/services/ws-url.ts`：
   - 规则：`{ws(s)}://{window.location.host}/ws?token={accessToken}`；协议随 `location.protocol`（https→wss）。
   - 允许 `import.meta.env.VITE_WS_URL` 显式覆盖（开发联调用）。
2. `App.tsx` 改用该构造函数，删除硬编码 `:8080`。
3. 桌面端 dev 模式（vite :3000 代理到 18080）保持可用：vite proxy 增加 `/ws` 的 `ws: true` 代理项（`packages/web/vite.config.ts`）。

**涉及文件**：
- `packages/web/src/services/ws-url.ts`（新增）
- `packages/web/src/App.tsx`
- `packages/web/vite.config.ts`

**验收标准**：
- 桌面端启动后 DevTools Network 可见 WS 连接 `ws://127.0.0.1:18080/ws` 101 成功；
- Web 云端 `wss://<domain>/ws` 101 成功；
- `make dev-web` + `make dev-server` 下 WS 连接 `ws://localhost:3000/ws` 经代理成功。

---

### 3.2 G2 — local 模式任务事件总线（替代 NoopNATS）

**现状证据**：
- `cmd/server/main.go:89`：local 模式 `engineNats = server.NewNoopNATSPublisher(logger)`；
- `server/nats_noop.go`：`Publish` 直接丢弃；
- `service/task_engine/engine.go:265`：任务完成发布 `aigc.task.completed` → local 模式被丢弃；
- `server/nats_ws_bridge.go` 仅 cloud 模式启动 → **桌面端 AIGC 任务进度/完成事件永远到不了前端**（前端 `aigc-store` 依赖 WS 的 `task:*` 事件）。

**施工内容**：
1. 新增进程内事件总线 `packages/server/internal/server/local_bus.go`：
   - 实现 `task_engine.NATSPublisher` 接口（`Publish(subject, data)` / `JetStream() nil`）；
   - `Publish` 直接按 subject 解析事件类型，复用 `nats_ws_bridge.go` 的转换逻辑推送 `WSHub.SendToUser`；
   - 事件 payload 补齐 `user_id`（见 3.3 的引擎修复，事件结构体增加 `user_id` 字段）。
2. `cmd/server/main.go`：local 模式用 `NewLocalBus(wsHub, logger)` 替换 `NewNoopNATSPublisher`；cloud 模式保持 NATSManager + NATSWsBridge 不变。
3. 统一事件结构：`taskEvent` 增加 `user_id`（int64→string），`engine.go` 发布 completed/failed/progress 事件时填充 `task.UserID`；`nats_ws_bridge.go` 同步适配（cloud 路径保持 SendToUser 定向推送，避免全站广播泄漏他用户任务）。

**涉及文件**：
- `packages/server/internal/server/local_bus.go`（新增）
- `packages/server/internal/server/nats_ws_bridge.go`（事件结构补 user_id）
- `packages/server/internal/service/task_engine/engine.go`（事件 payload 补 UserID）
- `packages/server/cmd/server/main.go`（接线替换）

**验收标准**：
- 桌面端提交 `/api/v1/aigc/generate` 后，前端 TaskStatusBar 实时出现任务并推进到 completed；
- 云端多用户场景下，A 用户收不到 B 用户的 `task:*` 事件（WS 消息定向）。

---

### 3.3 G3 — local 模式任务引擎 nil 锁 panic

**现状证据**：`cmd/server/main.go:92` local 模式 `distLock = nil`；`engine.go:211` `e.lock.Acquire(...)` 空指针调用 → 任何 AIGC 任务在桌面端直接 panic（worker goroutine 崩溃，任务卡 running）。

**施工内容**：
1. `engine.go` 增加 nil 锁防御：`if e.lock != nil { acquire... }`（单机单进程无需分布式锁）；
2. 或更优：提供 `dlock.NewLocalLock()`（进程内 sync.Map 实现同接口），local 模式注入，保持引擎代码零分支。**采用后者**（接口一致性，便于测试）。
3. 顺带修复：local 模式任务来源只有 `Submit`（无 JetStream 订阅），outbox 事件由 LocalBus 直接投递——确认 outbox publisher 在 local 模式不会重复投递（NoopNATS 已标记 published；改 LocalBus 后 Publish 即推送 WS，语义等价）。

**涉及文件**：
- `packages/server/internal/pkg/dlock/local_lock.go`（新增）
- `packages/server/cmd/server/main.go`（local 模式注入 LocalLock）

**验收标准**：
- 桌面端连续提交 3 个生图任务，全部进入 success/failed 终态，server.log 无 panic；
- `go test ./internal/service/task_engine/...` 通过（补 nil-lock/LocalLock 单测）。

---

### 3.4 G6 — 本地数据归属与免登录策略

**现状证据**：
- local 模式仍需 JWT（`AuthJWT` 中间件），但桌面端「离线免登录」要求下前端无会话时所有 `/api/v1` 请求 401 → **离线创作实际不可用**（与商业化方案 1.4「离线可用」矛盾）；
- `handler.GetUserID` 缺省返回 0，本地库数据 user_id=0；云端演示账号 id=1（13800000000）。M5 导入时 `sync_import.go` 以当前登录 uid 重写归属，逻辑可复用。

**施工内容**：
1. local 模式鉴权调整（`cmd/server/main.go` + `middleware/auth_jwt.go`）：
   - local 模式启动时自动签发「本机匿名会话」（uid=0 的 access token，随 `/health` 或专用 `/api/v1/auth/local-session` 下发），前端启动时若无会话则自动获取——**用户无感知免登录**；
   - 或更简方案：local 模式 AuthJWT 中间件在无 token 时注入 `user_id=0` 放行（回环绑定已保证本机安全）。**采用后者**，代码改动最小；云端行为不变。
2. 桌面端「登录云端账号」后：本地数据仍属 uid=0（本地库），云端拉取/推送走 M5 同步包（`.inkbloom`），导入云端时归属当前 uid——不改动本地库 user_id，避免双写混乱。
3. 前端：桌面端检测 `window.electronAPI` 存在时跳过强制登录门（`App.tsx` GuestApp 分支），直接进主界面；AI/云同步入口再唤起登录面板（复用 AuthPage 组件弹窗化）。

**涉及文件**：
- `packages/server/internal/middleware/auth_jwt.go`（local 放行注入 uid=0）
- `packages/server/cmd/server/main.go`（传入 mode 标记）
- `packages/web/src/App.tsx`（桌面端免登录分支）
- `packages/web/src/components/auth/AuthPage.tsx`（支持弹窗模式复用）

**验收标准**：
- 桌面端断网启动：可创建作品/章节/大纲/记忆并落 SQLite，重启后数据仍在；
- 桌面端 AI 按钮未登录时唤起登录面板，登录后走云端 AI 正常计费；
- 云端 Web 未登录访问仍被重定向登录页（行为不回归）。

---

## 4. P0-B Web 端部署与接入修复

### 4.1 G4 — Web 端 WS/部署形态

**施工内容**（与 3.1 协同）：
1. WS 相对路径（见 3.1）；
2. `packages/web/nginx.conf` 已含 `/ws` upgrade 与 `/api/` SSE 配置——**核对 `proxy_read_timeout` 对 SSE 流式 AI（5 分钟级）足够**，调整为 `3600s` 并将 `/api/v1/ai/` 单独 location 关闭 buffering（当前已关）；
3. 生产部署二选一（施工时按基础设施定）：
   - 方案 A（默认）：web 静态产物 + nginx 容器（现有 Dockerfile），compose 增加 `web` 服务环境差异化；
   - 方案 B：静态站点托管（OSS+CDN），API 域名分离——此时 CORS（4.2）与 WS 绝对地址（`VITE_WS_URL`）必须配置。
4. `docker-compose.yml` 增加生产 profile：`docker-compose.prod.yml`（新文件），含 web/server/ai-service/postgres/redis/nats + 环境变量模板 `.env.production.example`。

**涉及文件**：
- `packages/web/nginx.conf`
- `docker-compose.prod.yml`（新增）
- `.env.production.example`（新增）

**验收标准**：
- `docker compose -f docker-compose.prod.yml up -d` 后，`https://<domain>` 可注册登录、AI 流式对话不中断、WS 任务推送正常。

---

### 4.2 G5 — CORS 生产化

**现状证据**：`middleware/cors.go` 白名单仅 3 个 localhost origin。

**施工内容**：
1. CORS 允许来源改为配置驱动：`config.yaml` 新增 `server.cors_origins: ["https://app.inkbloom.cn", ...]`，env `INKBLOOM_SERVER_CORS_ORIGINS`（逗号分隔）；
2. 本地桌面端场景：Origin 为 `http://127.0.0.1:18080`（server 自托管页面，同源无 CORS 问题，但 dev 时 vite :3000 需保留）；
3. 默认 deny-all（未匹配不输出 Allow-Origin），保留 credentials=true。

**涉及文件**：
- `packages/server/internal/middleware/cors.go`
- `packages/server/internal/config/config.go`
- `packages/server/config.yaml`

**验收标准**：
- 生产域名跨域请求正常；非白名单 origin 的预检请求无 Allow-Origin 头；
- 桌面端与 dev 环境不回归。

---

## 5. P1 云端安全与合规基线

### 5.1 G7 — 全站限流中间件

**现状证据**：middleware 目录无限流；仅短信验证码 60s/条（`auth_service.go`）。

**施工内容**（按商业化方案 4.1 口径实施）：
1. 新增 `packages/server/internal/middleware/ratelimit.go`：Redis 滑动窗口（Lua 脚本），key 维度：
   - 未登录：`rl:ip:{ip}:{route}` 5 req/s + 500 次/日；
   - 登录常规：`rl:uid:{uid}` 20 req/s + 20,000 次/日；
   - AI 接口：`rl:ai:{uid}` 1 req/s + 300 次/日；
   - 短信：`rl:sms:{phone_hash}` 60s + 日 5 条；`rl:sms:ip:{ip}` 日 10 条。
2. 429 响应格式按方案冻结：`{code:429, message, data:{scope, retry_after, limit, used}}` + `Retry-After` 头。
3. local 模式降级：kvstore 内存实现同接口（`kvstore.Store` 已有，封装窗口计数）。
4. 挂载位置：`http.go` 在 `api.Use(authMiddleware)` 之后按路由组挂载不同配额；`/api/v1/auth/*` 挂未登录档。

**涉及文件**：
- `packages/server/internal/middleware/ratelimit.go`（新增）
- `packages/server/internal/server/http.go`
- `packages/server/internal/pkg/kvstore/*`（如需窗口原语）

**验收标准**：
- 压测脚本连续请求 `/api/v1/novels` 超过 20 QPS 出现 429 且带 Retry-After；
- 短信接口同号 60s 内第二次请求 429；
- local 模式限流同样生效（内存版）。

---

### 5.2 G8 — 密钥与配置卫生

**现状证据**：
- `config.yaml` 明文提交 `jwt.secret`（固定值）；
- `.env.example` 含形似真实的 `OPENAI_API_KEY=sk-368b...`；
- `config.go:150` jwt.secret 有硬编码默认值。

**施工内容**：
1. `.env.example` 密钥全部替换为占位符；仓库历史中的真实 key 立即吊销并轮换（运维动作，文档记录）；
2. `config.yaml` 移除 `jwt.secret`，改由 env `INKBLOOM_JWT_SECRET` 注入；`config.go` 在 cloud 模式启动时校验：secret 为空或等于已知默认值 → **拒绝启动**（local 模式保持随机生成逻辑）；
3. 新增 `config.yaml.example` 作为模板，真实 `config.yaml` 加入 `.gitignore`（保留 dev 默认值于 example）；
4. ai-service 的 `OPENAI_API_KEY` 同样只走环境变量，Dockerfile/compose 不落明文。

**涉及文件**：
- `.env.example`、`packages/server/config.yaml` → `config.yaml.example`、`.gitignore`
- `packages/server/internal/config/config.go`
- `docker-compose.yml` / `docker-compose.prod.yml`

**验收标准**：
- 仓库 grep 无任何真实密钥；
- cloud 模式无 `INKBLOOM_JWT_SECRET` 启动失败并给出明确错误；
- local 桌面端不受影响。

---

### 5.3 G9 — WS 鉴权与 Origin 校验加固

**现状证据**：
- `websocket.go:27` `CheckOrigin: return true`；
- token 走 query 明文（`App.tsx` 拼接 `?token=`）。

**施工内容**：
1. `CheckOrigin` 改为校验白名单（复用 5.2 的 cors_origins 配置；桌面端 127.0.0.1 放行）；
2. WS 鉴权升级：优先读 `Sec-WebSocket-Protocol: bearer.<token>` 子协议，兼容 query token 过渡一个版本；前端 `ws-url.ts` 同步改造（浏览器 WS 构造第二参数传子协议）；
3. 服务端握手成功后回显 `Sec-WebSocket-Protocol: bearer`；
4. access token 过期导致 WS 断开时，前端刷新 token 后重连（复用 auth-store refresh 单飞）。

**涉及文件**：
- `packages/server/internal/server/websocket.go`
- `packages/web/src/services/ws-url.ts`、`packages/web/src/services/ws-client.ts`

**验收标准**：
- 非白名单 Origin 的 WS 握手 403；
- query token 与子协议两种方式均可 101（过渡期），下一版本移除 query；
- token 过期→自动 refresh→重连成功，任务事件不丢。

---

## 6. P1 商业化闭环（真实支付/短信）

### 6.1 G10 — 支付宝/微信支付接入

**现状证据**：`pkg/payment/provider.go` alipay/wechat 为 stub；`payment_service.go` 仅 sandbox 即时到账。

**施工内容**：
1. **Provider 接口扩展**：`Prepay` 返回支付参数（支付宝：表单/二维码串；微信 Native：code_url），`CreateOrder` 响应 DTO 增加 `pay_payload` 字段；
2. 实现 `AlipayProvider`（alipay.trade.page.pay / faceToFace）与 `WechatProvider`（Native 下单，v3 API + 平台证书验签）：
   - 配置：`payment.alipay.{app_id,private_key,public_key,gateway}`、`payment.wechat.{mch_id,app_id,api_v3_key,serial_no,private_key_path}` 全部 env 注入；
   - 回调 `/api/v1/payment/notify/:channel` 实现真实验签（当前仅按 out_trade_no 入账，**无验签是资金安全隐患**）；
3. 主动查单兜底：支付后 30min 未回调 → 定时任务查单（渠道 query API）补入账；30min 未支付自动关单（`payment_orders` 增加 closer cron 或 lazy-close）；
4. 对账：T+1 拉取渠道账单与 `payment_orders` 核对，差异入 `admin` 队列（首期可人工导出比对，预留接口）；
5. 前端 `SubscriptionModal`/`TokenModal`：展示二维码（微信 code_url / 支付宝 qr）并轮询订单状态（`GET /payment/orders` 已有，需补单订单查询 `GET /payment/orders/:id`）。

**涉及文件**：
- `packages/server/internal/pkg/payment/{alipay.go,wechat.go}`（新增）
- `packages/server/internal/service/payment_service.go`
- `packages/server/internal/handler/billing_handler.go`
- `packages/web/src/components/billing/*.tsx`
- `packages/server/internal/config/config.go`

**验收标准**：
- 沙箱环境完成支付宝/微信真实下单→回调→订阅延期全链路；
- 伪造回调（无签名）被拒；
- 重复回调幂等（订阅只延期一次）。

### 6.2 G11 — 真实短信通道

**施工内容**：
1. 实现 `sms.AliyunProvider`（dysmsapi SendSms，签名+模板 CODE 配置化）；
2. `main.go` 按 `sms.provider: dev|aliyun` 配置切换；生产默认 aliyun，缺失配置拒绝启动 auth 相关端点（或降级 dev 并打 WARN——**仅 dev 环境允许**）；
3. 图形验证前置（行为验证码）：`/auth/sms-code` 增加 `captcha_token` 参数校验（阿里云验证码 2.0 服务端 SDK），前端 AuthPage 集成滑块组件。

**涉及文件**：
- `packages/server/internal/pkg/sms/aliyun.go`（新增）
- `packages/server/internal/service/auth_service.go`
- `packages/web/src/components/auth/AuthPage.tsx`

**验收标准**：
- 真实手机号收到验证码并可注册登录；
- 无 captcha_token 请求短信返回 400；
- 限流规则（5.1）生效。

### 6.3 G18 — SSE 流式端点计费

**现状证据**：`ai_handler.go` 注释明确「Streaming calls are not breaker-guarded」且 `forwardSSE` 无 tokenService 调用——`/ai/chat`、`/ai/inline`、`/ai/rewrite` 三个最高频端点**完全免费**，M4 计费体系形同虚设。

**施工内容**：
1. 流式预检：`forwardSSE` 入口 `CanConsume(uid, 预估下限)`，不足 402（JSON 错误，非 SSE）；
2. 用量回收：ai-service SSE 末帧（`[DONE]` 前）输出 `data: {"usage":{...}}` 元事件；Go 端转发时解析并缓存，流结束后 `Consume` 实际单位；
3. ai-service 改造：`/api/chat/stream`、`/api/chat/inline`、`/api/chat/rewrite` 在流尾追加 usage 事件（DeepSeek 流式响应 `stream_options.include_usage=true` 可获最终 usage）；
4. 客户端断连兜底：解析不到 usage 按 `FallbackConsumeUnits` 扣减并记 WARN。

**涉及文件**：
- `packages/server/internal/handler/ai_handler.go`
- `packages/ai-service/app/main.py`（SSE 尾帧 usage）
- `packages/web/src/services/sse-client.ts`（忽略 usage 元事件）

**验收标准**：
- 流式续写完成后 `token_ledger` 出现对应扣减流水（含 model/prompt/completion）；
- 余额不足时流式请求直接 402，前端弹充值；
- 中途断连按 fallback 扣减且日志可查。

---

## 7. P1 桌面端产品化（更新/备份/云同步入口）

### 7.1 G12 — 自动更新通道

**现状证据**：`electron-builder.yml` publish.url 为 `https://updates.inkbloom.example.com/` 占位；`updater.ts` 仅打印日志。

**施工内容**：
1. 更新 feed 托管：复用云端静态资源（OSS/CDN 或 server 静态目录），目录结构 `updates/stable/latest.yml + Setup.exe`、`updates/beta/...`；
2. `electron-builder.yml` publish.url 改为真实地址（构建期 env 注入 `UPDATE_FEED_URL`）；
3. `updater.ts` 完整交互：检查→有更新弹窗（版本/更新日志）→用户确认→下载（进度事件转发渲染进程）→退出安装；beta 通道由设置页开关（写入本地 config，IPC `config:set` 已有）；
4. 强制更新位：服务端 `/api/v1/public/flags` 响应增加 `min_desktop_version`；低于该版本的客户端启动时阻断并引导下载；
5. 发布流水线：Makefile 增加 `make desktop-release CHANNEL=stable`（构建→生成 latest.yml→上传 feed）。

**涉及文件**：
- `packages/desktop/electron/updater.ts`
- `packages/desktop/electron-builder.yml`
- `packages/server/internal/service/public_service.go`（flags 增字段）
- `Makefile`

**验收标准**：
- 安装旧版后启动检测到新版，确认后自动下载安装；
- 低于 min_desktop_version 的客户端被阻断并跳下载页。

### 7.2 G13 — 云同步入口（本地→云端首次导入）

**现状证据**：`main.ts` 菜单「云同步（即将上线）」disabled；M5 `/sync/export|import` 服务端已就绪，前端 `sync-store.ts` + `components/sync/DataModal.tsx` 已实现导出/导入 UI（Web 端）。

**施工内容**：
1. 桌面端复用 `DataModal`：主界面设置区增加「数据与同步」入口（桌面端免登录时点击先唤起登录面板）；
2. 「上传到云端」流程：调本地 `/sync/export` 生成 `.inkbloom` → 以云端凭证 POST 到云端 `/sync/import`（跨端点上传，前端直接 fetch 云端绝对地址，配置 `VITE_CLOUD_API_BASE`）；
3. 「从云端拉取」反向流程：云端 export → 本地 import；
4. 冲突提示沿用 M5 导入结果（created/updated/conflicts 计数弹窗）；
5. 菜单占位替换为真实入口。

**涉及文件**：
- `packages/desktop/electron/main.ts`（菜单）
- `packages/web/src/components/sync/DataModal.tsx`（双向流程扩展）
- `packages/web/src/stores/sync-store.ts`（跨端点上传/下载）

**验收标准**：
- 桌面端本地创作数据一键上传云端，Web 端登录可见；
- 云端修改后拉取回桌面端，冲突副本计数正确展示。

### 7.3 G14 — 素材目录纳入备份

**现状证据**：`backup_handler.go` 仅 `VACUUM INTO` 快照 DB；`%APPDATA%/InkBloom/assets/`（立绘/生成图）无备份。

**施工内容**：
1. `BackupHandler.CreateBackup` 增加 assets 增量归档：快照 DB 后将 `assets/` 自上次备份以来变更文件打入 `backups/{name}.assets.zip`（记录上次备份 manifest 的 mtime 清单）；
2. `ListBackups` 响应附带 assets 包信息；
3. 恢复流程（新增 `POST /api/v1/system/restore`）：选择备份→停写→恢复 DB + 解压 assets→重启服务（桌面端弹确认框，主进程调用）；
4. 保留策略同步覆盖 assets 包（与 DB 快照同名同生命周期）。

**涉及文件**：
- `packages/server/internal/handler/backup_handler.go`
- `packages/desktop/electron/backup.ts`
- `packages/desktop/electron/main.ts`（恢复入口 + 确认对话框）

**验收标准**：
- 备份目录同时存在 `.db` 与 `.assets.zip`；
- 删除素材后执行恢复，素材文件完整还原；
- 保留策略清理时成对删除。

---

## 8. P2 可观测性与运维

### 8.1 G15 — 指标、日志与告警

**施工内容**：
1. **Prometheus 指标**：引入 `prometheus/client_golang`，`middleware/metrics.go` 记录 `http_requests_total{route,status}`、`http_request_duration_seconds`；暴露 `/metrics`（cloud 模式，内网或带 basic auth）；任务引擎增加 `task_processed_total{type,status}`、`task_duration_seconds`；Token 扣减增加 `token_consumed_total{endpoint}`；
2. **访问日志采样**：AI 类端点请求体不落盘（仅长度），响应状态+延迟全量；`logger.go` 增加 `X-Request-ID` 生成与透传（前端 api-client 生成 uuid）；
3. **健康检查增强**：`/health` 返回 db/redis/nats/ai-service 依赖存活（cloud）；`/healthz`（轻量）供 LB；
4. **告警（首期轻量）**：server 启动时注册 panic→Webhook（企业微信/钉钉）通知；支付回调失败、Token 扣减失败 WARN 日志聚合日报（脚本化，后续接 Grafana）；
5. ai-service：FastAPI 增加 `/metrics`（prometheus-fastapi-instrumentator）与请求日志。

**涉及文件**：
- `packages/server/internal/middleware/metrics.go`（新增）
- `packages/server/internal/server/http.go`
- `packages/server/internal/handler/health.go`
- `packages/ai-service/app/main.py`

**验收标准**：
- `/metrics` 可抓取且含上述指标；
- 请求日志均带 request_id，前后端可串联；
- 依赖故障时 `/health` 返回 503 及明细。

---

## 9. P2 内容安全与协议合规

### 9.1 G16 — AIGC 内容安全网关

**施工内容**：
1. 新增 `packages/server/internal/pkg/contentsafety/`：阿里云内容安全（文本审核 + 图片审核）客户端，接口 `CheckText(ctx, text) (pass bool, labels []string)` / `CheckImage(ctx, url)`；
2. 接入点：
   - AI 文本：Go 代理层在转发 ai-service 前校验 prompt（输入），SSE/JSON 响应聚合后校验输出（流式按句缓冲送检，命中即截断并返回合规提示）；
   - 文生图：prompt 送检（`aigc_handler.go` 提交前），生成图落库前图片送检（`image_handler.go`），命中则任务失败 + 自动退款（复用 Refund）；
3. 配置开关 `contentsafety.enabled` + provider 配置；未启用时打 WARN 日志（上线前必须启用）；
4. 违规记录落库（新表 `content_violations`，migration 020）：user_id/类型/命中标签/时间，供运营后台复审队列。

**涉及文件**：
- `packages/server/internal/pkg/contentsafety/*`（新增）
- `packages/server/internal/handler/ai_handler.go`、`aigc_handler.go`
- `packages/server/internal/service/task_engine/image_handler.go`
- `packages/server/migrations/020_content_violations.up.sql`

**验收标准**：
- 送检违规 prompt 返回合规提示且不产生计费；
- 违规图片任务失败并自动退款；
- 运营后台可查询违规记录。

### 9.2 G17 — 协议与备案页面

**施工内容**：
1. 落地页页脚挂载：用户协议、隐私政策、算法备案编号、ICP 备案号、公安备案号（静态 Markdown 渲染页 `/legal/*`，内容由运营提供，前端留占位路由与样式）；
2. 注册流程增加协议勾选（未勾选禁止提交）+ 勾选记录落库（`users` 增加 `agreed_terms_at` 字段，migration 021）；
3. 首次登录弹窗展示「创作内容将传输至模型服务商」告知（隐私政策 5.5 条），确认记录 localStorage + 服务端；
4. 账号注销入口（设置页）：二次短信验证→15 天冷静期标记（`users.status=2`）→冷静期任务物理删除（cron 或 lazy）。

**涉及文件**：
- `packages/web/src/components/legal/*`（新增）
- `packages/web/src/components/auth/AuthPage.tsx`
- `packages/server/migrations/021_users_terms.up.sql`
- `packages/server/internal/service/auth_service.go`（注销流程）

**验收标准**：
- 未勾选协议无法注册；
- 注销后登录提示冷静期，可撤销；
- 页脚链接可访问且含备案占位。

---

## 10. P3 体验与功能完善

### 10.1 G19 — 桌面端多平台构建

**施工内容**：
1. macOS：electron-builder dmg + 签名/公证（证书运维准备）、`paths.ts` 数据目录走 `app.getPath('userData')`（已兼容）、Go server 交叉编译 darwin-arm64/x64 universal；
2. Linux：AppImage + deb，server 编译 linux-x64；
3. CI（GitHub Actions）：矩阵构建三平台安装包，产物上传 Release + 更新 feed；
4. Windows 签名（可选，消除 SmartScreen 警告）。

**验收标准**：三平台安装包可安装启动，内嵌 server 正常 spawn。

### 10.2 G20 — Web 端质量基线

**施工内容**：
1. 包体积预算：`vite build` 产物 gzip 总量 < 1.5MB（当前 chunkSizeWarningLimit 1200KB 已接近），TipTap/cytoscape 按需懒加载（路由级 dynamic import）；
2. 首屏性能：落地页 LCP < 2.5s（图片压缩 + 字体子集 + 预连接 API 域名）；
3. 冒烟脚本：`packages/web/scripts/smoke.mjs`（构建产物关键路由 200 + 关键资源存在），接入 CI；
4. 错误监控：前端 window.onerror/unhandledrejection 上报 `/api/v1/feedback`（复用反馈通道，type=crash）。

**验收标准**：CI 冒烟通过；Lighthouse 性能分 ≥ 85。

---

## 11. 施工里程碑

| 期 | 内容 | 依赖 | 验收关口 |
|----|------|------|----------|
| **W1（P0，1 周）** | 3.1 WS 地址 + 3.2 本地事件总线 + 3.3 nil 锁 + 4.2 CORS | 无 | 桌面端 AIGC 任务全链路（进度→完成→插入编辑器）可用；Web dev 环境不回归 |
| **W2（P0，1 周）** | 3.4 本地免登录 + 4.1 生产部署形态（compose.prod + nginx） | W1 | 桌面端断网创作可用；生产域名部署冒烟通过 |
| **W3（P1，2 周）** | 5.1 限流 + 5.2 密钥卫生 + 5.3 WS 加固 + 6.3 SSE 计费 | W1 | 限流压测达标；流式 AI 扣费流水正确；仓库零密钥 |
| **W4（P1，2 周）** | 6.1 真实支付 + 6.2 真实短信 | W3（限流前置） | 沙箱全链路收款到账；真实短信注册成功 |
| **W5（P1，1 周）** | 7.1 自动更新 + 7.2 云同步入口 + 7.3 素材备份 | W2 | 旧版客户端自动升级；本地↔云端双向同步成功；备份可恢复 |
| **W6（P2，2 周）** | 8.1 可观测 + 9.1 内容安全 + 9.2 协议合规 | W3 | /metrics 可抓；违规内容拦截；协议勾选闭环 |
| **W7（P3，按需）** | 10.1 多平台 + 10.2 质量基线 | W5 | 三平台安装包；CI 冒烟绿 |

**上线关键路径**：W1→W2→W3→W4（支付/短信是收费前置）；合规备案（算法备案/ICP 许可）为运维并行项，周期 2–4 个月，立即启动。

---

## 12. 全局验收清单

**桌面端（手动验收，用户自测）**：
- [ ] 断网启动：创作/大纲/记忆/导出全可用，重启数据不丢
- [ ] AIGC 生图：任务进度实时更新，完成自动入素材库，可插入编辑器
- [ ] 登录云端：AI 可用且扣 Token；本地数据可上传云端
- [ ] 自动更新：旧版检测新版并安装成功
- [ ] 备份恢复：DB + 素材完整还原

**Web 端（手动验收，用户自测）**：
- [ ] 注册登录：真实短信验证码全流程
- [ ] 订阅：真实支付（扫码）→ 订阅延期 → 到期只读 402
- [ ] Token：充值 → AI 调用（含流式）扣减 → 流水/用量面板一致
- [ ] 限流：连续高频请求出现 429 友好提示
- [ ] WS：任务推送实时，token 过期自动续期重连

**API/工程级验收（Agent 执行）**：
- [ ] `go build ./...`、`go test ./...` 全绿（server）
- [ ] `pnpm -r build` 全绿（web/desktop）
- [ ] `curl` 冒烟：/health、注册、登录、AI 流式、生图任务、支付回调幂等
- [ ] 仓库 grep 无真实密钥；cloud 无 JWT_SECRET 拒绝启动
- [ ] `/metrics` 指标存在；CORS 白名单外 origin 被拒

---

> **文档信息**
> - 版本：v2.0（施工版）
> - 依据：`InkBloom-技术方案-v1.md`、`docs/product-commercialization-plan.md`、2026-08-20 代码现状核对
> - 使用方式：按里程碑 W1→W7 派发 Agent 施工；每项「验收标准」即 Done 定义
