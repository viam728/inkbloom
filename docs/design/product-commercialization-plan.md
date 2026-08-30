# InkBloom 产品商业化方案

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0（草案，待逐项确认） |
| 撰写日期 | 2026-08-07 |
| 适用范围 | packages/web、packages/server、packages/ai-service、packages/desktop |
| 市场范围 | 仅中国大陆市场（支付宝/微信支付、手机号/微信 OAuth、ICP 与算法备案） |
| 状态 | 方案待确认，未实施任何代码变更 |

## 现状基线（方案依据，已与代码核对）

| 维度 | 现状 |
| --- | --- |
| 仓库结构 | Monorepo（pnpm workspace）：`packages/web`（React + TS + Vite + TipTap + zustand，dev :3000）、`packages/server`（Go + Gin + GORM + PostgreSQL 16 / Redis 7 / NATS JetStream，:8080）、`packages/ai-service`（Python + FastAPI，:8100）、`packages/desktop`（Electron 34 + electron-builder，已有壳工程） |
| 鉴权 | 单一静态 token：`middleware.Auth(cfg.Auth.Token)`，配置于 `packages/server/config.yaml` 的 `auth.token`（当前值 `inkbloom-dev-token`）；WebSocket 走 `/ws?token=` 查询参数。**无用户体系** |
| 数据形态 | PG 表：`novels` / `volumes` / `chapters` / `settings` / `characters`（001_init）、`tasks`（002）、`knowledge_nodes` / `knowledge_edges`（003）、`assets`（004）、`novel_outline` / `novel_memory` / `media_contents` / `media_topics`（005）、`media_memory`（006）。大纲/记忆/节奏为整包 JSONB 文档（前端契约所有，带 `version` 乐观锁）；`media_memory` 为全局单例 JSONB（`id = 1`）；前端另有 localStorage 降级缓存 |
| AI 链路 | Go 薄代理（`/api/v1/ai/*`、`/api/v1/aigc/*`、`/api/v1/prompt/build`）→ ai-service（OpenAI 兼容 provider 注册表，现为 DeepSeek，默认模型 `deepseek-v4-flash`；上游仅认 `deepseek-v4-pro` / `deepseek-v4-flash`）。能力含续写/润色/扩写/候选/评审/场景化 agent 生成/文生图 |
| 文件存储 | `storage.NewFileStorage()`，素材经 `/assets/files` 静态服务，立绘上传端点 `/novels/:id/portraits`、`/media/portraits` |

**已定决策（不再讨论）**：① 离线架构走「Electron 内嵌本地服务」路线（安装包内嵌 Go server + SQLite），本方案按此直接设计；② 仅国内市场；③ 基础订阅定价 10 元/月；④ AI 用量以独立 Token 包售卖，与订阅解耦。

---

## 一、免费离线模式（Electron 桌面端）

**结论：桌面端免费下载、无需登录即可使用全部创作功能（编辑/大纲/记忆/导出），AI 能力与云功能需联网登录；ai-service 不内嵌，AI 一律走云端。**

### 1.1 内嵌架构

安装包内嵌三件套：Electron 主进程 + 内嵌 Go server（`packages/server` 交叉编译产物 `inkbloom-server.exe`）+ 前端静态产物（`packages/web` 构建后由 Electron `BrowserWindow` 加载本地文件）。`packages/desktop` 已有 electron-builder 骨架（`electron-builder.yml`、`electron:build` 脚本），本方案在其上补齐「内嵌服务生命周期管理」。

**关于 ai-service 是否内嵌——结论：不内嵌。** 理由：

1. AI 能力的真实算力在云端模型 API（DeepSeek），ai-service 只是 prompt 编排与 provider 适配的薄层，本地部署它并不能离线获得任何 AI 能力，仍需联网调模型；
2. 内嵌 Python 运行时（FastAPI + 依赖）会使安装包体积增加 300 MB 以上、启动慢、升级复杂，且 prompt 编排逻辑属于需要快速迭代的核心资产，放云端可即时更新；
3. 生图能力依赖文生图 provider，本地无意义。

因此：**本地只内嵌数据服务（Go server + SQLite），AI 请求在登录态下直连云端 `/api/v1/ai/*`（Go 代理 + ai-service 集群）**。桌面端在架构上就是一个「登录了云端账号、但数据默认存本地」的客户端。

**组件图（离线模式）：**

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 安装包（packages/desktop）                          │
│                                                             │
│  ┌────────────────┐        ┌─────────────────────────────┐  │
│  │  主进程 main    │        │  渲染进程（packages/web 产物）│  │
│  │  - 启动/监控     │        │  React + TipTap + zustand   │  │
│  │    内嵌服务      │  IPC   │  API base = 127.0.0.1:18080 │  │
│  │  - 自动更新      │◄──────►│  WS  = ws://127.0.0.1:18080 │  │
│  │  - 备份调度      │        └──────────────┬──────────────┘  │
│  └───────┬────────┘                          │ HTTP/WS        │
│          │ spawn（随应用启动/退出）            ▼                │
│  ┌───────┴───────────────────────────────────────────────┐  │
│  │  内嵌 Go server（inkbloom-server.exe，监听 127.0.0.1）  │  │
│  │  - Gin 路由 /api/v1/*（与云端同契约）                   │  │
│  │  - GORM dialect: sqlite（替代 PostgreSQL 16）           │  │
│  │  - 进程内事件总线（替代 NATS JetStream，WS 直连）         │  │
│  │  - 本地内存限流/缓存（替代 Redis，单机无必要）            │  │
│  │  - 文件存储 → %APPDATA%/InkBloom/assets                 │  │
│  └───────────────────────────────┬───────────────────────┘  │
│                                  │ SQLite                    │
│                        %APPDATA%/InkBloom/inkbloom.db        │
└─────────────────────────────────────────────────────────────┘
               ▲ 登录后（仅以下流量出本机，TLS）
               │
   ┌───────────┴──────────────────────────────┐
   │  InkBloom 云端                             │
   │  server(:8080) ──► ai-service(:8100)      │
   │        │                  │               │
   │   PostgreSQL 16      DeepSeek API         │
   │   Redis 7 / NATS     文生图 provider       │
   └──────────────────────────────────────────┘
```

**中间件裁剪结论（单机场景）：**

| 云端组件 | 云端职责 | 本地替代方案 | 理由 |
| --- | --- | --- | --- |
| PostgreSQL 16 | 主存储，JSONB | **SQLite 3**（GORM sqlite driver，WAL 模式） | 单用户单文件，JSONB 以 TEXT 存 JSON，语义等价 |
| Redis 7 | 缓存、限流、任务状态缓存 | **进程内 LRU + SQLite** | 单机单进程无跨实例共享需求 |
| NATS JetStream | 异步任务（AIGC 生图、知识抽取）事件流 | **进程内 channel 事件总线**，任务状态落 SQLite `tasks` 表 | 单机无分布式消费者；AI 任务本身仍需联网，事件只在本机流转 |
| WebSocket Hub | 任务进度推送 | 保留（本地 server 直连渲染进程） | 前端 `wsClient` 契约不变 |

**端口与安全**：内嵌 server 固定监听 `127.0.0.1:18080`（避开云端 8080 与常用端口），启动时生成随机本地会话密钥注入前端，防止本机其他进程冒用；仅绑定回环地址，不对局域网暴露。

### 1.2 本地持久化

**数据目录规范（Windows）：**

```
%APPDATA%/InkBloom/
├── inkbloom.db              # SQLite 主库（WAL：附 -wal / -shm）
├── assets/
│   ├── portraits/           # 角色立绘（对应 /novels/:id/portraits 上传）
│   ├── aigc/                # 生成图（assets 表，对应 /aigc/assets）
│   └── uploads/             # 其他素材
├── backups/                 # 自动备份（见 1.3）
├── exports/                 # 用户手动导出落盘目录（可改）
└── logs/                    # server 与 Electron 日志，滚动保留 14 天
```

macOS 对应 `~/Library/Application Support/InkBloom/`（如后续出 Mac 版，路径由 Electron `app.getPath('userData')` 统一解析，代码不写死）。

**SQLite schema 与云端 PG 的对应关系：** 迁移脚本与 `migrations/001~006` 一一对应，由构建期脚本自动生成 SQLite 方言版本（禁止手工维护两套漂移）：

| PG 类型/特性 | SQLite 对应 | 说明 |
| --- | --- | --- |
| `BIGSERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 本地 id 空间独立，云迁移时做 id 映射（见 3.2） |
| `JSONB` | `TEXT`（存 JSON 字符串） | 整包文档契约不变：`novel_outline.acts`、`novel_memory.items`、`media_memory.items`、`chapters.content_json` 等照搬 |
| `TIMESTAMPTZ` | `TEXT`（RFC3339，UTC） | 应用层统一解析 |
| 部分唯一索引（如 `uniq_chapters_novel_position`） | SQLite 支持 `WHERE deleted_at IS NULL` 的部分索引 | 直接等价迁移 |
| `version` 乐观锁 | 原样保留 | 整包文档 upsert 逻辑（`novel_doc_handler` / `media_handler`）完全复用 |

**关键约束：前端契约零改动。** 前端所有 store/service 面向的 DTO、乐观锁 version 语义、`media_memory` 单例（`id=1`）行为在本地与云端完全一致——这正是「Electron 内嵌本地服务」路线的核心红利：前端代码一套，仅切换 `API base`（本地 `127.0.0.1:18080` ↔ 云端域名）。前端 localStorage 降级缓存保留，作为本地库损坏前的最后一道兜底。

**素材/立绘文件**：云端 `storage.NewFileStorage()` 的目录根参数化（配置项 `storage.root`），本地指向 `%APPDATA%/InkBloom/assets`；`/assets/files` 静态路由在本地模式下保留（渲染进程直接经回环访问），素材入库记录沿用 `assets` 表。

**SQLite 方言差异的其它处理：**

| 差异点 | 处理 |
| --- | --- |
| 无 `TIMESTAMPTZ` | 应用层 GORM 钩子统一写 RFC3339 UTC 字符串，读时转回 `time.Time` |
| 无原生 UPSERT 部分语法 | 整包文档 upsert（现 PG 的 `ON CONFLICT ... DO UPDATE`）改用 SQLite `ON CONFLICT(novel_id) DO UPDATE`，语义等价 |
| 并发写 | 单用户场景下 WAL 模式 + 应用层串行写队列（写操作排队，读不受阻） |
| 全文检索（未来需求） | 预留 FTS5 扩展位，首期不做 |
| 迁移执行 | 内嵌 server 启动时自动执行 SQLite 迁移（版本号存 `schema_migrations` 表），失败则阻断启动并提示恢复入口 |

**Electron 主进程生命周期时序：**

```
app.ready
  ├─ 1. 解析数据目录（app.getPath('userData')）
  ├─ 2. 检测端口 18080 占用（被占则递增探测 18081~18090）
  ├─ 3. 生成随机会话密钥 → 写入进程环境变量
  ├─ 4. spawn 内嵌 server（--port=18080 --db=%APPDATA%/InkBloom/inkbloom.db）
  ├─ 5. 轮询 /health（间隔 200ms，超时 10s → 弹错误页附日志路径）
  ├─ 6. 创建 BrowserWindow 加载前端（注入 API base + 会话密钥）
  └─ 7. 备份调度器启动（见 1.3）

window-all-closed / before-quit
  ├─ 1. 通知前端落盘未保存内容（localStorage 兜底已存在）
  ├─ 2. 向 server 发 SIGTERM（优雅退出：flush WAL + 关闭连接，超时 5s 强杀）
  └─ 3. 退出前备份检查（若有写操作且距上次 ≥ 24h）
```

崩溃守护：主进程监控子进程退出码，非正常退出自动重启最多 3 次，连续失败引导用户查看 `logs/` 并反馈。

### 1.3 备份策略

| 项 | 结论 |
| --- | --- |
| 自动备份触发 | ① 应用启动且距上次备份 ≥ 24 小时；② 每日 03:00（应用保持运行时）；③ 应用退出前若有写操作 |
| 备份方式 | SQLite Online Backup API（`VACUUM INTO 'backups/xxx.db'`），一致性快照，不打断写入；同时增量归档 `assets/` 中自上次备份后变更的文件 |
| 备份位置 | `%APPDATA%/InkBloom/backups/inkbloom-YYYYMMDD-HHmmss.db` + 素材增量包 `.assets.zip` |
| 保留策略 | 保留最近 **7 份**（每日一份）+ 每月 1 日额外保留 **3 个月度份**；超出自动清理 |
| 手动导出 | 顶栏「导出作品」已存在（`/export/chapter`、`/export/novel`）；另增「导出整个工作区」→ `.inkbloom` 包（见 3.2 导出包格式） |
| 损坏恢复 | 启动时 `PRAGMA integrity_check`：失败则自动用最近一份备份恢复到 `inkbloom.restored.db` 并提示用户确认切换；连续 3 份备份均失败时引导用户从云端拉取（若已登录）或提交日志求助 |
| 云备份（订阅权益） | 订阅用户开启云同步后，云端 PG 即权威副本，本地备份仍保留（双保险） |

### 1.4 功能边界表

**离线可用（无需登录，本地 SQLite 支撑）：**

| 模块 | 具体能力 | 对应现有端点（本地内嵌 server 提供） |
| --- | --- | --- |
| 小说创作 | 作品/卷/章节 CRUD、拖拽排序、字数统计 | `/novels*`、`/chapters*`、`/volumes*` |
| 三模式编辑 | 小说模式、自媒体模式、笔记模式（TipTap 统一富文本） | `/chapters/:id/content`、`/media/contents*` |
| 大纲 | 幕结构大纲编辑（整包 JSONB + version） | `/novels/:id/outline` |
| 记忆 | 作品记忆四分组、媒体记忆单例 | `/novels/:id/memory`、`/media/memory` |
| 设定/角色 | 设定表、角色卡、立绘本地上传 | `settings`、`/characters*`、`/novels/:id/portraits` |
| 选题看板 | 媒体选题卡片看板 | `/media/topics` |
| 格式/导出 | 格式转换预览、章节/整书导出 txt/md/docx | `/format/*`、`/export/*` |
| 本地备份 | 自动/手动备份与恢复 | 见 1.3 |

**必须联网 + 登录（云端独占）：**

| 模块 | 说明 |
| --- | --- |
| AI 全部能力 | 续写、润色、扩写、候选、评审、灵感、作品/媒体分析、大纲扩写、标题生成、内容改编、场景化 agent 生成（`/ai/*`）、生图 prompt 与文生图（`/aigc/*`）、知识图谱抽取与校验（`/knowledge/*`） |
| 云同步 | 本地 SQLite ↔ 云端 PG 双向同步（订阅权益） |
| 跨设备 | Web 端访问、多设备数据一致（订阅权益） |
| 订阅与 Token 权益 | 订阅开通/续费、Token 包充值与消费 |
| 账号能力 | 注册、登录、找回密码、设备管理 |

---

## 二、浏览器端登录与账户体系

**结论：Web 端（packages/web 部署形态）强制登录；注册以「手机号 + 短信验证码」为主渠道、「邮箱 + 密码」为辅渠道、「微信扫码」为快捷渠道；鉴权采用 JWT（access 2h + refresh 30d）。**

### 2.1 Web 端强制登录的拦截策略

双层拦截，路由级负责体验，接口级负责安全兜底：

1. **路由级（前端）**：`packages/web` 引入 `AuthProvider` 包裹 `App.tsx`。未登录访问任何创作路由 → 重定向 `/login?redirect=<原路径>`；登录成功后回跳。现有 `App.tsx` 中写死的 `ws://...:8080/ws?token=inkbloom-dev-token` 改为从 token store 注入 `Authorization`（WS 握手用 `Sec-WebSocket-Protocol` 携带 access token，弃用 query 明文 token）。
2. **接口级（后端）**：`middleware.Auth(cfg.Auth.Token)` 替换为 `middleware.JWT()`：校验 `Authorization: Bearer <access_token>`，解析 `user_id` 注入 `gin.Context`；401 响应体统一 `{code:401, message, data:{reason:"expired"|"invalid"}}`，前端拦截器对 `expired` 自动走 refresh 重试一次，失败则登出跳登录页。
3. **WebSocket**：`/ws` 握手阶段校验 token，失败关闭连接（code 4401）。
4. **豁免路由**：`/health`、`/api/v1/auth/*`（注册/登录/验证码/刷新）、落地页静态资源。

**桌面端策略差异**：离线模式不强制登录（本地内嵌 server 用本地会话密钥鉴权）；用户在桌面端触发 AI / 云同步时才唤起登录面板。静态 token 方案在桌面端本地服务中保留为「本机回环密钥」的简化形态（启动时随机生成），不复用云端凭证。

### 2.2 注册登录选型结论

| 渠道 | 定位 | 结论与理由 |
| --- | --- | --- |
| 手机号 + 短信验证码 | **主渠道**（注册即登录） | 国内写作工具用户习惯；天然实名，满足合规（网信办要求 UGC/AIGC 服务账号实名）；兼作找回凭证 |
| 微信扫码 OAuth | **快捷渠道**（一键登录） | 转化率最高的国内第三方登录；首次微信登录后**强制补绑手机号**（合规要求），补绑前不可发布/使用 AIGC 对外能力 |
| 邮箱 + 密码 | **辅渠道** | 覆盖不愿给手机号的用户与海外华人预留；注册后同样建议补绑手机号 |

**短信通道与成本**：接阿里云短信（国内验证码短信约 0.045 元/条，以服务商当期报价为准）。控制成本手段：同号码 60 秒限 1 条、日上限 5 条、同 IP 日上限 10 条、图形验证前置（见 4.3）。按注册转化率估算，单个有效注册获客的短信成本 ≤ 0.15 元。

**微信 OAuth 成本**：微信开放平台「网站应用」扫码登录需企业资质 + 300 元/年认证费；无个体户捷径，列入运营开办成本（见 3.3 主体要求）。

### 2.3 多端安装引导页（落地页）

落地页为独立静态站（与 `packages/web` 应用分离部署，未登录可访问），结构自上而下：

1. **首屏**：产品名 + 一句话定位（「写给长期主义者的 AI 创作工作台」）+ 双 CTA：**「下载 Windows 桌面版（免费离线）」** 主按钮、**「打开网页版」** 次按钮（点击跳登录）；
2. **端能力差异对比表**（直接给出，减少决策成本）：

| 能力 | 桌面版（免费离线） | 网页版（需登录） | 订阅会员（10 元/月） |
| --- | --- | --- | --- |
| 三模式编辑/大纲/记忆/导出 | ✅ 完全离线 | ✅ | ✅ |
| 自动备份 | ✅ 本地 | —（云端即存储） | ✅ 云端 + 本地双副本 |
| AI 续写/润色/生图等 | 需联网登录 + Token | 需登录 + Token | 需登录 + Token（与订阅解耦） |
| 云同步 / 跨设备 | — | ✅（登录后） | ✅ |
| 多设备同时使用 | 1 台免登录 + 其余需登录 | 最多 3 端在线 | 最多 3 端在线 |

3. **桌面版下载区**：Windows x64 安装包（electron-builder NSIS），显示版本号/大小/SHA-256，附「安装指引」折叠块；macOS/Linux 标注「敬请期待」；
4. **功能走查**：三张场景卡（小说作者 / 自媒体创作者 / 笔记党），各配截图；
5. **定价区**：订阅 10 元/月权益说明 + Token 包价目（导流至第五章价目表）；
6. **页脚**：ICP 备案号、公安备案、用户协议、隐私政策、算法备案编号（占位位）。

### 2.4 账户体系技术设计

**users 表（云端 PG 新增）：**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | BIGSERIAL PK | 用户 id |
| `phone` | VARCHAR(20) UNIQUE NULL | 手机号（AES-GCM 加密存储，见 4.2） |
| `phone_hash` | CHAR(64) UNIQUE NULL | SHA-256(手机号)，用于登录查找（密文不可检索问题的解法） |
| `email` | VARCHAR(255) UNIQUE NULL | 邮箱 |
| `password_hash` | TEXT NULL | argon2id 哈希（手机号验证码注册的用户可为空） |
| `wechat_openid` | VARCHAR(64) UNIQUE NULL | 微信开放平台 openid |
| `wechat_unionid` | VARCHAR(64) NULL | 为将来公众号/小程序矩阵预留 |
| `nickname` | VARCHAR(64) | 默认「墨客xxxx」 |
| `avatar_url` | VARCHAR(500) | |
| `status` | SMALLINT | 0=正常 1=禁用 2=注销冷静期 3=已注销 |
| `role` | SMALLINT | 0=普通用户 1=运营（后台权限） |
| `last_login_at` | TIMESTAMPTZ | |
| `registered_channel` | VARCHAR(20) | sms / wechat / email |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**JWT 方案：**

| 参数 | 结论 |
| --- | --- |
| Access token | HS256（单服务集群足够；未来拆服务再升 RS256），有效期 **2 小时**，载荷：`uid`、`role`、`sub_plan`（订阅状态摘要）、`jti` |
| Refresh token | 随机 256-bit，存 `user_sessions` 表（可吊销），有效期 **30 天**，滑动续期：每次刷新签发新 refresh（旧的作废），实现「活跃用户无感续期、30 天不活跃强制重登」 |
| 刷新流程 | access 过期 → 前端拦截器用 refresh 调 `POST /api/v1/auth/refresh` → 新 access + 新 refresh；refresh 失效 → 401 登出 |
| 登出/踢出 | 删除 `user_sessions` 对应行即可即时失效（JWT 短时效 + 可吊销 refresh 的组合避免黑名单成本） |

**密码策略：**

- 哈希算法：**argon2id**（内存 64MB、迭代 3 次、并行度 1），优于 bcrypt 的抗 GPU 特性，Go 侧 `golang.org/x/crypto/argon2`；
- 强度：8~64 位，须含字母 + 数字（不强制符号/大小写，避免国内用户流失，强度提示条引导）；
- 找回流程：优先「手机号验证码重置」；仅邮箱账号走「邮件链接（15 分钟有效、一次性）重置」；重置成功踢掉所有既有会话；
- 撞库防护：同一账号连续 5 次密码错误 → 锁定 15 分钟并提示走验证码登录。

**认证接口清单（新增 `/api/v1/auth/*`）：**

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/auth/sms/send` | POST | 发验证码（手机号 + 场景：register/login/reset），前置行为验证 |
| `/auth/register` | POST | 手机号 + 验证码注册，返回双 token，自动开通 14 天试用 |
| `/auth/login/sms` | POST | 手机号 + 验证码登录 |
| `/auth/login/password` | POST | 邮箱/手机号 + 密码登录 |
| `/auth/login/wechat` | POST | 微信 OAuth code 换登录（首登未绑手机返回 `need_bind` 临时态） |
| `/auth/bind-phone` | POST | 微信用户补绑手机号 |
| `/auth/refresh` | POST | refresh 换新双 token |
| `/auth/logout` | POST | 吊销当前会话 |
| `/auth/password/reset` | POST | 验证码/邮件链接重置密码 |
| `/auth/sessions` | GET/DELETE | 设备列表 / 下线指定会话 |

---

## 三、订阅计费

**结论：基础订阅 10 元/月，权益为「云同步 + 跨设备 + 云端存储」；新用户注册即享 14 天全权益试用（无需支付凭证）；到期进入 30 天只读宽限期；数据保留 180 天后物理删除。AI 不含在订阅内（见第五章）。**

### 3.1 10 元/月基础订阅

**定价依据**：国内同类参考——秘塔写作猫基础版 24 元/月、高级版 48~96 元/月（App Store 公开价），纯码字工具（橙瓜 150 元/年、灯果 99.9 元/年、快乐码字 100 元/年，来源：bilibili 专栏《那些眼花缭乱的写作软件》及官网）。InkBloom 订阅只卖「同步/云端基础设施」，AI 成本单独走 Token 包，因此 10 元/月（约 108 元/年，年付 8 折 96 元/年）可打穿码字工具年费带，同时不与 AI 权益混淆。依据口径均为公开页面价格，查询时间 2026-08-07。

**订阅权益（明确边界）**：云端数据存储、本地↔云双向同步、Web 端与多设备访问（≤3 端在线）、云端自动备份副本。AI 能力、更大存储配额不属于订阅权益。

**免费试用期策略：**

| 项 | 结论 |
| --- | --- |
| 试用时长 | 注册成功即开通 **14 天**全订阅权益 |
| 是否需支付凭证 | **不需要**（免绑卡）。理由：国内支付绑卡试用转化损耗大，且 10 元客单价下薅羊毛成本风险低于拉新收益 |
| 试用提醒 | 第 10/12/13 天应用内横幅 + 登录页角标提醒剩余天数 |
| 试用到期行为 | 未付费 → 云端数据转**只读宽限期**（下述），本地离线功能完全不受影响（桌面端免费创作是永久权益，与试用无关） |

**到期后数据保留政策：**

| 阶段 | 时长 | 行为 |
| --- | --- | --- |
| 宽限期 | 到期后 **30 天** | 云端数据只读：可登录、可查看、可导出（`/export/*` 与 `.inkbloom` 工作区包），禁止写入/同步/AI |
| 休眠期 | 第 31~180 天 | 账号可登录但云端数据冻结，页面强提示「续费恢复」与「导出数据」；期间任意时点续费立即全量恢复 |
| 删除 | 满 **180 天**未续费 | 物理删除云端用户数据（novels/chapters 等归属行 + 素材文件），删除前 7 天发最后一次短信/站内通知；删除不可逆 |

告知渠道组合：站内横幅 + 登录弹窗 + 短信（仅关键节点：到期日、宽限期第 25 天、删除前 7 天），避免短信滥用。

**降级/退订流程：**

**订阅状态机（`subscriptions.status`）：**

```
trialing（注册即进入，14 天）
  ├─ 付费 ─► active ─ 到期未续费 ─► grace（30 天只读）
  ├─ 到期未付费 ─► grace             ├─ 续费 ─► active
  │                                 └─ 期满 ─► dormant（31~180 天冻结）
  │                                            ├─ 续费 ─► active
  │                                            └─ 满 180 天 ─► expired（数据删除）
  └─ （active 任意时点续费 = 到期日顺延，不设叠加折扣外的其它规则）
```

状态流转由每日凌晨定时任务驱动（扫描 `expires_at`），付费回调可即时激活；每次流转写审计日志并触发对应通知。

- 微信支付/支付宝均为商户侧代扣非自动续期场景下以「手动续费」为主（国内无 Apple 式强制自动续费约束，但接入自动续费需遵守《网络交易监督管理办法》第十八条：自动续费须在开通前显著提示、提供便捷取消途径）；
- **结论：首期只做手动续费（到期提醒 → 一键续费），不做自动代扣**，降低合规与客诉成本；
- 退订 = 不续费，无需操作；用户也可在设置页主动「立即结束订阅」，剩余天数按自然到期处理不退款（10 元客单价，不设比例退款，减少财务复杂度）。

### 3.2 本机数据导入云端（Electron SQLite → 云端 PG）

**导出包格式（`.inkbloom` zip）：**

```
workspace-20260807.inkbloom（zip）
├── manifest.json        # 版本、导出时间、源端标识（local/cloud）、实体计数、sha256 清单
├── db/                  # 每张业务表一个 JSON 文件（数组形式）
│   ├── novels.json      # 含本地 id、全部字段
│   ├── volumes.json
│   ├── chapters.json    # content、content_json 整包照搬
│   ├── novel_outline.json / novel_memory.json / media_memory.json ...
│   ├── media_contents.json / media_topics.json
│   ├── settings.json / characters.json
│   └── knowledge_nodes.json / knowledge_edges.json
└── assets/              # 素材与立绘原文件，目录结构与 assets 表 path 对应
```

整包 JSONB 文档（outline/memory）天然适合整体搬迁，不做字段级拆分。

**迁移流程（首次导入云端）：**

1. 桌面端「开通云同步」→ 生成本地快照导出包；
2. 分片上传：8 MB/片，每片带序号 + sha256，服务端 `POST /api/v1/sync/upload/init|chunk|finish` 幂等接口，支持断点续传（`finish` 前服务端记录已收分片位图，重传只补缺片）；
3. 服务端校验整包 sha256 清单后进入导入事务：为所有本地 id 建立 `sync_id_map`（local_id ↔ cloud_id）映射，重写外键（如 `chapters.novel_id`）后写入 PG；素材文件落对象存储并回填 `assets.path`；
4. 导入完成返回报告（成功条数/跳过条数/冲突条数）。

**冲突处理规则（双向同步阶段）：**

| 对象类型 | 规则 |
| --- | --- |
| 行级实体（novels/chapters/volumes/media_contents/settings/characters） | 以 `updated_at` 新者胜；`updated_at` 相同（±1s 容差内）则比 `version`（有者）；仍相同以**云端为准**（云端是多端汇聚点） |
| 整包 JSONB 文档（outline/memory/media_memory） | 已有 `version` 乐观锁：两端 version 都前进产生分叉时，取 `updated_at` 新者整包覆盖，**败者整包另存为冲突副本**挂在该 novel 的「版本历史」下供人工拣回（不做字段级 merge——前端契约即整包所有，字段级合并违背契约且收益低） |
| 删除冲突 | 一端已删另一端已改 → 保留「已改」版本（创作数据宁留勿删） |
| 素材文件 | 内容寻址（sha256 命名），天然幂等去重，无冲突 |

**增量同步设计：** 本地 server 增加 `sync_journal` 表记录每次本地写操作（表名/行 id/操作类型/updated_at/版本号）；同步时只上传 journal 增量；同步完成后打 checkpoint。云端变更经 WS 推送 + 拉取合并，同样走 journal。全量重同步作为兜底入口保留（设置页「重新对齐」）。

**断点续传**：上传分片化（上述）；下载同步包同样分片；网络中断后客户端按服务端位图续传，无需重头。

### 3.3 支付接入

**主体与资质要求（结论：以企业主体运营，个体户不可行）：**

| 资质 | 要求 | 说明 |
| --- | --- | --- |
| 营业执照 | 有限公司（经营范围含软件开发/信息技术服务） | 支付宝/微信商户号均要求企业或个体户，但 ICP 备案与下述备案建议企业主体 |
| ICP 备案 + 增值电信 | 域名 ICP 备案必须；**经营性收费需 ICP 经营许可证（ICP 许可/EDI）** | 订阅收费属经营性互联网信息服务，上线收费前取得 |
| 支付宝 | 企业账号开通「电脑网站支付 + 手机网站支付」，费率约 0.6% | 桌面端内支付走跳转浏览器收银台 |
| 微信支付 | 商户号 + Native 支付（扫码）/ JSAPI，费率约 0.6% | 落地页扫码、Web 内扫码统一用 Native |
| 算法备案 | 生成式 AI 服务须完成**深度合成/生成式 AI 算法备案**（网信办）并公示编号 | AI 功能商业化前置条件，周期 2~4 个月，提前启动 |
| 生成式 AI 合规 | 《生成式人工智能服务管理暂行办法》：内容标识、未成年人条款、投诉机制 | 纳入第六章协议框架 |

**订单状态机（`payment_orders` 表）：**

```
created（下单，落库并调渠道预下单拿支付参数）
  ├─► paid（收到渠道回调，验签 + 幂等）
  │     └─► fulfilled（权益交付成功：订阅延期 / Token 到账，写交付流水）
  │           └─► refunded（人工退款，回收权益）
  ├─► closed（30 分钟未支付自动关单）
  └─► failed（渠道明确失败）
```

要点：

- 回调处理三原则：**先验签、再幂等**（`out_trade_no` 唯一约束）、**先交付再应答渠道 success**；回调失败由主动查单兜底；
- 交付与支付解耦：paid 后由交付 worker 写 `subscriptions` / `token_accounts`，交付失败重试队列（云端用 NATS，首期 PG 队列表亦可）；
- **对账**：T+1 定时任务下载渠道对账单与 `payment_orders` 逐笔核对，差异单（长款/短款）进人工队列；金额、商户号、状态三字段强校验。

---

## 四、流量限制与安全边界

**结论：Redis 滑动窗口做全站限流；按身份分层配额；AI 接口叠加 Token 余额门禁与并发控制；数据隔离靠全表加 `user_id` 归属列 + GORM Scope 强制过滤。**

### 4.1 API 限流配额

**选型**：Redis + Lua 实现的**滑动窗口**（按分钟窗口），配合每用户日配额计数器（每日 0 点过期）。不选令牌桶的原因：配额数字对用户可解释（「每分钟 X 次」），且突发容忍需求低。限流命中返回 `429 + Retry-After`，前端展示友好提示。

| 身份 | 常规 API QPS（每用户/IP） | 常规 API 日配额 | AI 文本接口 | AI 并发 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 未登录（落地页/认证接口） | 5 req/s per IP | 500 次/IP/日 | — | — | 含验证码发送接口 |
| 登录未订阅（试用过期/宽限期） | 10 req/s | 5,000 次/日 | 禁用（订阅过期后 AI 仍可用，只要 Token 有余额——**AI 只认 Token 不认订阅**） | 1 | AI 权限仅取决于 Token 余额 |
| 订阅用户 | 20 req/s | 20,000 次/日 | 1 req/s，300 次/日 | 2（含生图任务） | 超出日配额 429 + 次日重置 |
| 同步接口（/sync/*） | 2 req/s | 200 次/日 | — | — | 分片上传另计，单文件 ≤ 50 MB |
| WebSocket | 单用户 ≤ 3 连接 | — | — | — | 对应多设备上限 |

**AI 接口额外门禁（在限流之上串行执行）：**

1. 订阅/登录校验；2. 限流；3. **Token 余额预检**：余额 ≥ 本次操作预估消耗（预估值表见 5.3）才放行，否则 402 + 引导充值；4. 并发闸（Redis 信号量，上限见上表）；5. 完成后按实际用量结算（见第五章流水）。

**短信接口专项**：同号 60s 1 条 / 同号日 5 条 / 同 IP 日 10 条，发送前置图形验证（行为验证，如阿里云验证码 2.0）。

**限流键设计与响应格式：**

| 维度 | Redis key 模式 | 窗口 |
| --- | --- | --- |
| 未登录接口 | `rl:ip:{ip}:{route}` | 秒级滑动 + 日计数 |
| 登录常规 API | `rl:uid:{uid}` | 分钟滑动 + 日计数 |
| AI 文本接口 | `rl:ai:{uid}` | 秒级 + 日计数 |
| AI 并发闸 | `sem:ai:{uid}`（信号量，请求完成/超时释放，TTL 120s 兜底） | 实时 |
| 短信 | `rl:sms:{phone_hash}` / `rl:sms:ip:{ip}` | 60s + 日 |

限流响应统一格式（前端据 `retry_after` 展示倒计时）：

```json
HTTP/1.1 429 Too Many Requests
Retry-After: 12
{ "code": 429, "message": "请求过于频繁，请稍后再试",
  "data": { "scope": "ai_daily", "retry_after": 12, "limit": 300, "used": 300 } }
```

余额不足响应（AI 专用，与限流区分）：

```json
HTTP/1.1 402 Payment Required
{ "code": 402, "message": "Token 余额不足",
  "data": { "balance": 8200, "required": 3700, "recharge_url": "/pricing/tokens" } }
```

### 4.2 数据安全

| 项 | 结论 |
| --- | --- |
| 用户数据隔离 | 现有 10 张业务表（`novels`/`volumes`/`chapters`/`settings`/`characters`/`novel_outline`/`novel_memory`/`media_contents`/`media_topics`/`media_memory`/`assets`/`knowledge_*`/`tasks`）全部新增 `user_id BIGINT NOT NULL` 列 + 索引；`media_memory` 由全局单例（`id=1`）改为 `(user_id)` 主键的每用户单例；repository 层统一挂 GORM Scope `WhereUser(uid)`，**禁止任何绕过 uid 过滤的查询**（code review 红线 + 单测覆盖）；本地离线模式下 `user_id` 恒为 0（本地设备匿名用户），导入云端时重写 |
| 传输 | 全站 TLS 1.2+（HSTS）；内嵌本地服务仅回环地址不走 TLS（本机无中间人面） |
| 存储加密 | 敏感字段 AES-256-GCM 应用层加密：手机号、邮箱（密钥走 KMS/配置分离，不落库）；密码 argon2id；PG 落盘加密依赖云厂商磁盘加密 |
| 日志脱敏 | 中间件层统一脱敏：手机号保留前 3 后 4、token/jwt 全掩码、请求体中的章节正文不落日志（仅记长度）；ai-service 侧 prompt 日志默认关闭，排障模式才开且 7 天自动清理 |
| 内容安全 | AIGC 输入输出过内容安全网关（阿里云内容安全，按量计费），命中违规则拒绝并记录——生成式 AI 合规硬要求 |

### 4.3 防滥用

| 维度 | 指标与动作 |
| --- | --- |
| 注册防刷 | 同设备指纹日注册 ≤ 2 个账号；新注册账号 24h 内为「观察期」：AI 日配额减半、导出无限制但云同步需过验证码二次确认 |
| 异常行为检测 | ① 单账号日 AI 调用 > 日均值 5σ → 临时冻结 AI 并人工复核；② 批量注册特征（同 IP 段 + 顺序手机号）→ 整段拉黑；③ 仅充值不创作（Token 转售嫌疑）→ 风控标记 |
| IP 限制 | 单 IP 并发在线账号 ≤ 5；数据中心 IP 段（云厂商 ASN 清单）默认禁止注册，人工解封 |
| 验证码触发 | 连续 3 次密码错误、异地登录（IP 城市跳变）、敏感操作（改绑手机/注销）均触发行为验证 |
| 接口防爬 | 全站接口要求登录态 + 签名时间戳（防重放 5 分钟窗口），`/assets/files` 静态资源签名 URL 化（15 分钟有效） |
| 申诉通道 | 误伤解封走客服工单（见 6.5），24h 内人工响应 |

---

## 五、AI 服务 Token 包商业化

**结论：Token 账户与订阅完全解耦（AI 只认余额不认订阅）；计量单位用「抵扣单位」（输入 token ×1 + 输出 token ×2，与 DeepSeek 输入/输出 1:2 成本比对齐）；三档 Token 包：体验包免费 50 万单位 / 标准包 9.9 元 300 万单位 / 专业包 25.9 元 1,000 万单位；生图按张单独计价（6 万单位/张）；余额校验在 Go 代理层统一拦截。**

### 5.1 Token 账户模型（与订阅解耦）

**表设计（云端 PG 新增）：**

| 表 | 核心字段 | 说明 |
| --- | --- | --- |
| `token_accounts` | `user_id` PK、`balance` BIGINT（剩余抵扣单位）、`gift_balance`（赠送余额，优先扣）、`total_recharged`、`total_consumed`、`version`（乐观锁）、`updated_at` | 每用户一行；余额永远 ≥ 0，数据库 CHECK 约束兜底 |
| `token_ledger` | `id`、`user_id`、`direction`（+充值/-消耗/±调整）、`amount`、`balance_after`、`reason`（recharge/gift/ai_call/image_gen/refund/admin）、`ref_type`+`ref_id`（关联订单或任务）、`model`、`prompt_tokens`、`completion_tokens`、`endpoint`、`created_at` | 只追加不修改（append-only），是账单与对账的唯一事实源 |
| `token_orders` | `id`、`user_id`、`pack_code`（trial/std/pro）、`units`、`amount_cents`、`payment_order_id` FK、`status`、`granted_at` | 与 `payment_orders` 一对一，交付幂等键 |

**余额校验中间件位置——结论：统一放在 Go 代理层（`packages/server`），不下沉到 ai-service。** 理由：① 所有 AI 流量必经 `/api/v1/ai/*`、`/api/v1/aigc/*` 薄代理，一处拦截覆盖全部 14 个 AI 端点；② ai-service 保持无状态的纯推理编排层，不碰钱；③ 与限流/鉴权中间件同层串联，顺序：JWT → 限流 → 余额预检 → 并发闸 → 转发。结算在代理层收到 ai-service 返回的 usage 字段后同事务写 ledger（余额扣减 + 流水一条 SQL 事务，`version` 乐观锁防并发透支）。

### 5.2 Token 包梯度与成本测算

**成本口径（DeepSeek 官方 API 计价，来源：api-docs.deepseek.com 价格页，查询时间 2026-08-07）：**

| 模型 | 输入（缓存命中） | 输入（缓存未命中） | 输出 | 备注 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash（默认） | 0.02 元/百万 token | 1 元/百万 token | 2 元/百万 token | 并发上限 2500 |
| deepseek-v4-pro | 0.025 元/百万 token | 3 元/百万 token | 6 元/百万 token | 并发上限 500，预计 8 月初开放 API |

注意两点风险已计入毛利测算：① DeepSeek 已公告将实行峰谷定价，高峰时段（每日 9:00–12:00、14:00–18:00）价格为平时 2 倍；② 本产品以续写/扩写为主，输入以新上下文为主，缓存命中率保守按 30% 估算。综合成本 ≈ （0.7×1 + 0.3×0.02）元/M 输入 + 2 元/M 输出，高峰时段上浮至约 2 倍，**按最坏情况（全未命中 + 高峰）成本上界 = 输入 2 元/M + 输出 4 元/M 做毛利兜底**。

**抵扣单位定义**：`1 抵扣单位 = 1 输入 token ≡ 0.5 输出 token`，即 `消耗 = 输入 token × 1 + 输出 token × 2`。这样计量与上游成本比严格对齐，用户侧换算简单（输出贵一倍，与行业惯例一致）。

**Token 包梯度：**

| 包 | 价格 | 抵扣单位 | 折合单价（元/百万单位） | 有效期 | 毛利测算（按正常成本 1 元/M 上界 2 元/M） |
| --- | --- | --- | --- | --- | --- |
| 体验包 | 免费（注册即送） | 50 万 | — | **90 天**（制造转化紧迫感） | 成本 ≤ 1 元/注册，视为获客成本 |
| 标准包 | **9.9 元** | 300 万 | 3.3 | 永久（随账户） | 正常毛利 ≈70%，最坏情况毛利 ≈40% |
| 专业包 | **25.9 元** | 1,000 万 | 2.59 | 永久 | 正常毛利 ≈61%，最坏 ≈23%；重度用户档 |

定价锚点说明：标准包 9.9 元与订阅 10 元同量级，降低首次付费心理门槛；体验包 50 万单位 ≈ 135 次续写（按 5.3 示例），足够完整体验一个创作 session。专业包不设更高档（避免 SKU 膨胀；重度消耗靠复购，复购时页面优先推专业包）。

### 5.3 消耗规则：按 token 计，生图按张计

**结论：文本类 AI 按「输入 + 输出 token」折算抵扣单位计（不按次计）。** 理由：① 与上游成本线性对齐，无被薅风险（按次计时用户会用超长上下文薅成本）；② 续写与评审的上下文长度差 5~10 倍，按次定价必然一方吃亏；③ 抵扣单位透明可展示（每次调用后弹窗「本次消耗 X 单位」）。

**各 AI 操作计费示例**（基于现有端点，输入含 system prompt + 上下文拼装，按中文 1 字 ≈ 1.5 token 估算；单价按标准包 3.3 元/百万单位）：

| 操作（端点） | 典型输入 | 典型输出 | 抵扣单位 | 折合金额 |
| --- | --- | --- | --- | --- |
| 续写 `/ai/inline` | 2,500 | 600 | 3,700 | ≈ 0.012 元 |
| 润色 `/ai/rewrite` | 1,500 | 800 | 3,100 | ≈ 0.010 元 |
| 扩写 `/ai/expand-outline` | 4,000 | 2,000 | 8,000 | ≈ 0.026 元 |
| 候选 `/ai/candidates`（3 条） | 2,000 | 1,500 | 5,000 | ≈ 0.017 元 |
| 评审 `/ai/review` | 6,000 | 1,500 | 9,000 | ≈ 0.030 元 |
| 作品/媒体分析 `/ai/analyze-story` `/ai/analyze-media` | 8,000 | 2,500 | 13,000 | ≈ 0.043 元 |
| 场景化 agent 生成 `/ai/agent/generate` | 8,000 | 4,000 | 16,000 | ≈ 0.053 元 |
| 知识抽取 `/knowledge/extract` | 10,000 | 3,000 | 16,000 | ≈ 0.053 元 |
| 生图 prompt `/aigc/prompt` | 1,000 | 300 | 1,600 | ≈ 0.005 元 |
| **文生图 `/aigc/generate`** | — | — | **60,000/张**（固定） | ≈ 0.20 元/张 |

**生图按张计价理由**：文生图 provider 本身按张计费（国内主流文生图 API 约 0.04~0.16 元/张，本方案成本假设 0.10 元/张），按张对用户最直观；6 万单位定价折合 0.20 元/张，毛利 ≈50%。失败的生成任务（provider 报错）不扣费，预扣部分全额回滚。

**预扣-结算两段式**：请求进入时按上表预估值预扣（冻结），任务成功按实际 usage 结算多退少补，失败全额解冻——防止余额不足的用户把任务跑完再赖账。

**计费时序（以续写为例）：**

```
前端            Go 代理（余额中间件）           ai-service          DeepSeek
 │  POST /ai/inline   │                          │                   │
 ├──────────────────► │ 1.JWT/限流校验            │                   │
 │                    │ 2.预检余额≥3700？         │                   │
 │                    │ 3.预扣 3700（ledger 冻结行）│                  │
 │                    ├──────────────────────► │ 调 deepseek-v4-flash │
 │                    │                          ├───────────────► │
 │                    │                          │◄─────────────── │
 │                    │◄────────────────────── │ 返回正文+usage      │
 │                    │ 4.结算：实际 3420 → 退 280 │（prompt/completion）│
 │                    │ 5.写正式流水（同一事务）    │                   │
 │◄────────────────── │ 响应（附 consumed=3420） │                   │
```

**流水示例（token_ledger 单行）：**

```
id=90212  user_id=1001  direction=-  amount=3420  balance_after=2996580
reason=ai_call  ref_type=task  ref_id=t_8812  model=deepseek-v4-flash
prompt_tokens=2480  completion_tokens=470  endpoint=/ai/inline
created_at=2026-08-07T14:23:11+08:00
```

**退款与负值防护**：余额列 CHECK `balance >= 0`；并发请求靠 `version` 乐观锁串行化扣减，扣减失败（冲突）重试一次，仍失败则返 402；运营侧赠送/补偿走 `direction=+ reason=admin` 流水，双人复核后才可执行。

### 5.4 消耗监控

| 能力 | 设计 |
| --- | --- |
| 实时余额 | `GET /api/v1/token/balance` 返回 `balance/gift_balance`；前端顶栏常驻余额徽标，AI 调用后自动刷新 |
| 消耗明细 | `GET /api/v1/token/ledger?page=&size=&type=` 分页流水，每条展示时间/操作类型/模型/输入输出 token/扣减额/余额快照 |
| 低余额预警 | 阈值一：余额 < **10 万单位**（约 27 次续写）→ 应用内橙色横幅；阈值二：余额 < 上次充值包的 **20%** → 弹层推标准包；AI 调用余额不足时返回 402 并直接附充值入口 |
| 用量统计面板 | 设置页「用量」Tab：日/周/月柱状图（基于 `token_usage_daily` 每日聚合表，字段：user_id/date/text_units/image_count/image_units），另展示「最常用 AI 能力 Top3」 |
| 运营侧 | 后台可查全站 Token 消耗趋势、ARPU、 packs 销量、余额分布（见 6.6） |

### 5.5 成本收益粗算（用于拍板参考）

假设稳定期 1 万注册、订阅转化率 8%、Token 付费转化率 5%、付费用户月均充值 1.5 次（以标准包为主）：

| 收入项 | 月估算 | 口径 |
| --- | --- | --- |
| 订阅收入 | 10 元 × 800 人 = **8,000 元** | 含年付摊销后按月折算 |
| Token 包收入 | 500 人 × 1.5 次 × 约 11 元 = **约 8,250 元** | 标准包 9.9 / 专业包 25.9 混合均价 |
| 合计 | **约 1.6 万元/月** | |

| 成本项 | 月估算 | 口径 |
| --- | --- | --- |
| DeepSeek 调用成本 | ≈ Token 收入 × 30%（正常毛利 70% 口径）≈ **2,500 元** | 5.2 成本口径，缓存命中 30% 假设 |
| 生图成本 | 生图收入折半 ≈ **800 元** | 成本 0.10 元/张，售价 0.20 元/张 |
| 云资源（PG/Redis/OSS/CDN 小规格） | **约 1,500 元** | 起步规模，随用户量线性增长 |
| 短信 + 内容安全 + 行为验证 | **约 600 元** | 注册量驱动 |
| 合计 | **约 5,400 元/月** | |

即万级注册规模下毛利率约 65%，验证「低价订阅获客 + Token 包赚毛利」的组合可持续；若 DeepSeek 峰谷定价生效后成本翻倍，毛利降至约 50%，仍在安全线内。本小节所有数字为拍板用粗算，不作为财务承诺。

---

## 六、其他产品化补充

### 6.1 用户协议与隐私政策框架（要点清单）

1. 服务主体与联系方式（企业名称、邮箱、地址）；
2. 账号注册与实名：手机号实名、禁止转让账号；
3. 付费条款：订阅权益边界、Token 包属「预付费虚拟权益」的退款规则（未消耗部分依法可退，已消耗不退）、价格调整提前 7 天公示；
4. 生成式 AI 专项条款（《生成式人工智能服务管理暂行办法》要求）：AI 生成内容标识、不得用于违法内容生成、输入内容责任归属、未成年人使用限制；
5. 隐私政策：收集的个人信息清单（手机号/邮箱/创作内容/设备信息/日志）与目的逐项对应、存储位置（境内）、保存期限、第三方共享清单（支付渠道/短信/内容安全/DeepSeek——**明确告知创作内容会传输至模型服务商**）；
6. 用户权利：查阅/复制/更正/删除/注销的入口与时限；
7. 内容权利：用户保有创作内容全部著作权，平台仅获服务必需的存储/处理授权；
8. Cookie 与本地存储说明（含前端 localStorage 降级缓存用途）；
9. 协议变更通知机制（站内公告 + 首次启动弹窗确认）。

### 6.2 数据导出与账户注销

| 项 | 结论 |
| --- | --- |
| 数据导出 | 任意状态（含宽限期/休眠期）均可一键导出 `.inkbloom` 全量包（见 3.2）+ 个人信息副本（手机号/邮箱/订单记录 CSV）；导出完成短信通知 |
| 注销入口 | 设置页「账号与安全 → 注销账号」，需二次验证（短信验证码） |
| 注销冷静期 | **15 天**（期间登录可撤销注销）；注销前提：订阅已到期或明确放弃、Token 余额提示处理（可申请退未消耗部分） |
| 删除时限 | 冷静期满后 **15 个工作日内**完成个人信息与创作数据物理删除（含备份与日志中的可识别信息），法定留存项（交易日志按《电子商务法》留存 ≥ 3 年）除外；删除完成短信告知 |

### 6.3 多设备登录策略

- **同时在线上限：3 个会话**（Web + 桌面端合计，以 `user_sessions` 活跃 refresh 计）；
- 超出时的踢出规则：**踢出最早活跃会话**，被踢端收到 4403 WS 关闭码 + 弹窗「账号已在其他设备登录」；
- 桌面端离线使用不占会话（未登录状态）；登录后才计入；
- 设置页「设备管理」：列出会话（设备名/类型/最后活跃/IP 城市），可单个下线或全部下线。

### 6.4 版本更新与灰度发布

| 层 | 方案 |
| --- | --- |
| Electron 自动更新 | electron-updater + 自托管静态 feed（`latest.yml` + 安装包放 OSS/CDN，不走 GitHub）；双通道 `stable` / `beta`（设置页可选），beta 先行 1 周；强制更新位（最低兼容版本）由服务端 `/api/v1/client/config` 下发，schema 不兼容时阻断旧客户端写云端 |
| 服务端灰度 | 网关层按 `user_id % 100` 分流：新功能先 5% → 25% → 100%；灰度开关存 Redis，运营后台一键切换；数据库 migration 坚持「先兼容后清理」两阶段变更 |
| ai-service 灰度 | prompt 版本化（prompt 模板带版本号），新 prompt 先对 10% 流量 A/B，观测采纳率后全量 |

### 6.5 客服/反馈入口

- 应用内：侧栏「帮助与反馈」→ 工单表单（自动附带账号/版本/诊断日志开关，不默认上传内容数据）；AI 生成结果旁设「点踩 + 原因标签」直通反馈库；
- 渠道：站内工单（主）+ 客服邮箱（公示）+ 用户 QQ 群/微信群（运营）；
- SLA：普通工单 24h 响应、支付/账号类 4h 响应（工作时间内）；退款类工单 3 个工作日办结。

### 6.6 运营后台需求清单

| 模块 | 需求 |
| --- | --- |
| 用户 | 搜索（手机号/昵称/uid）、状态管理（禁用/解禁）、会话踢出、注销审批 |
| 订阅 | 订阅列表与到期日历、手工延期/补偿、宽限期/休眠期名单 |
| Token | 充值订单、发放/扣减调整（双人复核）、对账差异单处理、退款操作 |
| 数据看板 | DAU/WAUU、注册渠道分布、留存（次日/7 日）、订阅转化漏斗、Token 消耗趋势与 ARPU、AI 各能力调用量与采纳率 |
| 风控 | 限流命中看板、黑名单管理、异常账号队列 |
| 内容安全 | 违规拦截记录、人工复审队列（生成式 AI 合规要求） |
| 发布 | 灰度开关、客户端版本分发（stable/beta 包管理） |

---

## 附录

### A. 数据库新增表清单汇总

| 表名 | 一行摘要 |
| --- | --- |
| `users` | 账号主表：手机号（密文+hash）/邮箱/微信 openid/argon2id 密码哈希/状态/角色 |
| `user_sessions` | refresh token 会话：设备指纹/类型/IP/过期时间，支持单点吊销 |
| `sms_codes` | 短信验证码：手机号 hash/用途/过期 5 分钟/次数限制 |
| `subscriptions` | 订阅：用户/计划/起止时间/状态（trialing/active/grace/dormant/expired）/自动续费标志 |
| `payment_orders` | 支付订单：渠道/金额/外部单号/状态机 created→paid→fulfilled |
| `token_accounts` | Token 余额账户：余额/赠送余额/累计充值与消耗/version |
| `token_ledger` | Token 流水（append-only）：方向/金额/余额快照/模型/输入输出 token/关联单 |
| `token_orders` | Token 包充值订单：包档位/单位数/支付单关联/交付状态 |
| `token_usage_daily` | 用量日聚合：用户/日期/文本单位/生图张数/生图单位 |
| `sync_id_map` | 本地↔云 id 映射：表名/本地 id/云端 id，支撑导入与增量同步 |
| `sync_journal` | 同步增量日志（本地 SQLite 侧）：表名/行 id/操作/updated_at/checkpoint |
| `feedback` | 反馈工单：类型/内容/附件/状态/处理人 |
| `audit_logs` | 运营后台操作审计：操作人/对象/动作/前后值 |

**核心表关键 DDL 要点（实施时以正式 migration 为准）：**

```sql
-- users：唯一约束均建在可空列上（PG 允许多个 NULL 互不冲突）
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    phone BYTEA NULL, phone_hash CHAR(64) UNIQUE NULL,
    email VARCHAR(255) UNIQUE NULL,
    password_hash TEXT NULL,
    wechat_openid VARCHAR(64) UNIQUE NULL, wechat_unionid VARCHAR(64) NULL,
    nickname VARCHAR(64) NOT NULL, avatar_url VARCHAR(500),
    status SMALLINT NOT NULL DEFAULT 0, role SMALLINT NOT NULL DEFAULT 0,
    registered_channel VARCHAR(20) NOT NULL,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- token_accounts：余额强约束 + 乐观锁
CREATE TABLE token_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    gift_balance BIGINT NOT NULL DEFAULT 0 CHECK (gift_balance >= 0),
    total_recharged BIGINT NOT NULL DEFAULT 0,
    total_consumed BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- token_ledger：append-only，仅插入权限（应用层不暴露 UPDATE/DELETE 路径）
CREATE TABLE token_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    direction SMALLINT NOT NULL,            -- 1=入账 -1=扣减
    amount BIGINT NOT NULL CHECK (amount > 0),
    balance_after BIGINT NOT NULL,
    reason VARCHAR(32) NOT NULL,
    ref_type VARCHAR(32), ref_id VARCHAR(64),
    model VARCHAR(64), prompt_tokens INT, completion_tokens INT,
    endpoint VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ledger_user_time ON token_ledger(user_id, created_at DESC);

-- subscriptions：状态机 + 到期日驱动
CREATE TABLE subscriptions (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    plan VARCHAR(20) NOT NULL DEFAULT 'base',
    status VARCHAR(20) NOT NULL DEFAULT 'trialing',
    started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    grace_until TIMESTAMPTZ,                -- 宽限期截止 = expires_at + 30d
    last_payment_order_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subs_expiry ON subscriptions(status, expires_at);

-- payment_orders：外部单号幂等键
CREATE TABLE payment_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    kind VARCHAR(20) NOT NULL,              -- subscription / token_pack
    ref_id BIGINT,                          -- 关联订阅记录或 token_orders.id
    channel VARCHAR(20) NOT NULL,           -- alipay / wechat
    amount_cents INT NOT NULL,
    out_trade_no VARCHAR(64) NOT NULL UNIQUE,
    channel_trade_no VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    paid_at TIMESTAMPTZ, fulfilled_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

业务表改造示例（以 novels 为例，其余表同理）：

```sql
ALTER TABLE novels ADD COLUMN user_id BIGINT NOT NULL DEFAULT 0;
CREATE INDEX idx_novels_user ON novels(user_id) WHERE deleted_at IS NULL;
-- media_memory 单例改造：主键由 id 改为 user_id，存量行 id=1 挂到演示账号
```

### B. 改造影响面摘要（现有模块需要动哪些）

| 模块 | 影响点 |
| --- | --- |
| `packages/server` | ① `middleware.Auth` 静态 token → JWT 中间件 + 用户上下文注入；② 全部 repository/handler 增加 `user_id` 归属过滤（涉及 novel/chapter/volume/media/doc/portrait/knowledge/aigc/export 全部 handler）；③ `media_memory` 单例模型改造（`id=1` → per-user）；④ 新增 auth/subscription/payment/token/sync 五组 handler + 服务；⑤ `storage` 目录根参数化；⑥ 限流中间件（Redis Lua）；⑦ 配置层新增 jwt/secret/支付/短信/存储根配置项 |
| `packages/server/migrations` | 新增 007（用户体系）、008（订阅与支付）、009（token 账户三表）、010（业务表 user_id 回填）、011（同步相关表）；另需 SQLite 方言迁移生成器 |
| `packages/ai-service` | ① 响应体增加 usage 字段（prompt/completion tokens，供计费）；② prompt 版本化；③ 内容安全网关接入点；④ 去除对静态 token 的依赖（改为信任 Go 代理内网调用签名） |
| `packages/web` | ① AuthProvider + 登录/注册/找回页面；② WS 鉴权改造（弃 query token）；③ API base 可配置化（本地/云端）；④ 余额徽标/充值页/用量面板/设备管理/注销流程页面；⑤ 落地页独立站点 |
| `packages/desktop` | ① 内嵌 Go server 生命周期管理（spawn/健康检查/退出回收）；② 自动更新（electron-updater + 自托管 feed）；③ 备份调度；④ 登录面板与云同步开关 |
| 基础设施 | PG/Redis 上云、对象存储（素材）、CDN（落地页/安装包）、短信服务、内容安全服务、KMS |

### C. 实施里程碑建议（仅规划，不实施）

| 期 | 周期 | 交付物 | 验收要点 |
| --- | --- | --- | --- |
| M1 账户体系 | 3 周 | users/JWT/注册登录/用户隔离改造（全表 user_id） | 旧数据 user_id=0 平滑回填；所有接口带归属过滤 |
| M2 离线桌面端 | 4 周 | 内嵌 Go server + SQLite、备份、离线全功能 | 断网可用；与云端契约一致（同一套前端） |
| M3 订阅与支付 | 4 周 | 订阅/试用/宽限期/支付宝微信支付/订单状态机/对账 | 支付回调幂等通过故障演练；试用→宽限→休眠状态机自动流转 |
| M4 Token 商业化 | 3 周 | token 三表/余额中间件/三档包/生图计价/用量面板 | 预扣-结算一致性；最坏成本毛利 ≥ 20% |
| M5 同步与合规 | 4 周 | `.inkbloom` 导入/双向同步/冲突副本/协议与备案材料提交/运营后台 v1 | 断点续传与冲突副本回归测试；ICP/算法备案材料递交 |
| M6 上线灰度 | 2 周 | 落地页/灰度发布/监控告警/客服流程 | 5%→25%→100% 放量；支付与 AI 链路全监控 |

各期之间的硬依赖：M1 是 M3/M4/M5 的前置；M2 可与其他期并行；算法备案与 ICP 许可在 M1 启动时即并行提交（周期最长，是事实上线关键路径）。

---

## 待确认清单

> 以下决策点需要逐项拍板；编号与文档章节对应，回复编号 + 结论即可。

| # | 问题 | 方案默认值 | 涉及章节 |
| --- | --- | --- | --- |
| Q1 | ai-service 不内嵌、AI 全部走云端，是否确认？ | 不内嵌（安装包体积/迭代速度/生图依赖） | 1.1 |
| Q2 | 本地内嵌 server 端口 18080（回环）与随机本地会话密钥，是否确认？ | 确认 | 1.1 |
| Q3 | 自动备份：启动 + 每日，保留 7 日份 + 3 个月度份，是否确认？ | 确认 | 1.3 |
| Q4 | 注册主渠道手机号 + 验证码，微信登录强制补绑手机号，是否确认？ | 确认（合规驱动） | 2.2 |
| Q5 | JWT access 2h / refresh 30d 滑动续期，argon2id 密码哈希，是否确认？ | 确认 | 2.4 |
| Q6 | 试用期 14 天免绑卡、宽限期 30 天、休眠至 180 天删除，时长是否确认？ | 确认 | 3.1 |
| Q7 | 首期只做手动续费、不做自动代扣，是否确认？ | 确认 | 3.1 |
| Q8 | 同步冲突：updated_at 新者胜、整包文档败者存冲突副本、不做字段级 merge，是否确认？ | 确认 | 3.2 |
| Q9 | 限流配额（订阅用户 20 QPS/日 2 万、AI 1 QPS/日 300 次）是否确认？ | 确认 | 4.1 |
| Q10 | AI 权益只认 Token 余额、不捆绑订阅，是否确认？ | 确认 | 4.1/5.1 |
| Q11 | Token 包三档：体验 50 万免费（90 天）/标准 9.9 元 300 万/专业 25.9 元 1,000 万，价格与数量是否确认？ | 确认（基于 DeepSeek 官方计价 + 毛利测算） | 5.2 |
| Q12 | 抵扣单位公式（输入 ×1 + 输出 ×2）与生图 6 万单位/张，是否确认？ | 确认 | 5.3 |
| Q13 | 多设备同时在线上限 3、踢最早活跃会话，是否确认？ | 确认 | 6.3 |
| Q14 | 里程碑 M1–M6 约 20 周排期与备案并行策略，是否确认？ | 确认 | 附录 C |

---

*本文档为商业化方案草案，所有价格/配额/时长参数在确认后将作为实施基线；外部计价与竞品价格均注明来源与查询时间（2026-08-07），实施前如 DeepSeek 峰谷定价正式生效，需按 5.2 毛利兜底口径复核一次 Token 包定价。*
