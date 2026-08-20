# InkBloom — 技术方案（v1 · 自媒体 AIGC 图文工具）

> 🎯 目标：面向**自媒体创作者**的 AIGC 图文创作桌面工具。完整保留小说文本编辑能力，新增 AIGC 插图/视频生成、多平台格式转换、一键发布等核心功能。
>
> 🎯 求职亮点：**深入服务端理解** + **熟练 AI 编程融合** — 借助 AI 实现全栈项目的同时，展现高并发、分布式架构设计能力。
>
> 📐 设计原则：**Go 主服务 + Python AI 服务 · 事件驱动 · 分布式就绪 · 单人可落地 · 单人可部署。**
>
> ⏱ 文档时间：2026-07-14

---

## 目录

1. [设计哲学与核心命题](#1-设计哲学与核心命题)
2. [系统架构总览](#2-系统架构总览)
3. [技术栈选型与理由](#3-技术栈选型与理由)
4. [前端架构](#4-前端架构)
5. [Go 主服务架构](#5-go-主服务架构)
6. [Python AI 服务架构](#6-python-ai-服务架构)
7. [数据层设计](#7-数据层设计)
8. [消息队列与事件驱动（NATS）](#8-消息队列与事件驱动nats)
9. [分布式任务引擎](#9-分布式任务引擎)
10. [AI 文本引擎](#10-ai-文本引擎)
11. [AIGC 图片生成系统](#11-aigc-图片生成系统)
12. [AIGC 视频生成系统（远期预留）](#12-aigc-视频生成系统远期预留)
13. [多平台格式转换系统](#13-多平台格式转换系统)
14. [知识图谱](#14-知识图谱)
15. [泛用功能设计](#15-泛用功能设计)
16. [安全与隐私](#16-安全与隐私)
17. [部署策略与性能指标](#17-部署策略与性能指标)

---

## 1. 设计哲学与核心命题

### 1.1 双重命题

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     InkBloom 的双重使命                                   │
│                                                                         │
│  产品使命：                                                              │
│  ├─ 面向自媒体创作者的 AIGC 图文创作工具                                  │
│  ├─ 写完即发：多平台一键复制、格式自适应                                  │
│  ├─ 边写边画：AI 辅助续写 + AIGC 插图异步生成                            │
│  └─ 知识驱动：知识图谱自动提取、一致性检测                                │
│                                                                         │
│  求职使命：                                                              │
│  ├─ 展示深入的服务端理解：并发模型、分布式协调、事件驱动架构               │
│  ├─ 展示 AI 编程融合力：借助 AI 高效交付全栈项目                         │
│  ├─ 展示架构设计力：合理的技术选型、清晰的分层、可扩展的接口               │
│  └─ 展示工程素养：代码质量、测试覆盖、容器化部署、CI/CD                   │
│                                                                         │
│  面试可深聊的技术点：                                                     │
│  ├─ Go 并发：goroutine pool / channel 编排 / context 超时控制             │
│  ├─ 分布式协调：Redis 分布式锁 / 幂等任务处理 / 限流熔断                  │
│  ├─ 事件驱动：NATS 发布订阅 / 事件溯源 / 最终一致性                       │
│  ├─ gRPC 流式：AI 响应的 Server Streaming / 背压控制                      │
│  ├─ 数据库：PostgreSQL JSONB / CTE / 窗口函数 / 全文检索                  │
│  ├─ 缓存策略：Redis 多级缓存 / Cache-Aside / 缓存穿透防护                 │
│  └─ AI 工程：Prompt Engineering / Provider 可插拔 / Token 预算管理        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 设计原则

| 原则 | 说明 | 体现 |
|------|------|------|
| **Go 主力，Python 专精** | Go 处理核心业务和高并发场景，Python 专注 AI 推理 | 语言选型服务于场景，而非一刀切 |
| **事件驱动** | 服务间通过 NATS 消息队列异步通信，松耦合 | AIGC 任务、进度推送、跨服务事件 |
| **分布式就绪** | 架构支持水平扩展，单机部署即可运行 | 分布式锁、幂等处理、熔断限流 |
| **接口优先** | gRPC Protobuf 定义服务契约，前后端/服务间解耦 | 强类型、向后兼容、自动生成代码 |
| **渐进增强** | 基础功能零依赖可用，配置 API Key 解锁高级能力 | Pollinations 免费图片 → DALL-E 高质量 |
| **可观测** | 结构化日志 + 指标暴露 + 健康检查 | 面试可展示运维意识 |

### 1.3 架构演进对比

| 维度 | 过度设计版 | v1 当前版 |
|------|-----------|----------|
| 目标 | 10万并发 / 同城双活 | 展示架构能力 / 单机可运行 / 理论上可水平扩展 |
| 后端 | Go+Python 7个微服务 + K8s | Go 主服务 + Python AI 服务（2 个进程） |
| 消息队列 | Kafka 6节点 + RocketMQ | NATS JetStream（单节点，协议级事件驱动） |
| 数据库 | TiDB + MongoDB + Redis + ES | PostgreSQL + Redis（合理组合） |
| 部署 | K8s 多集群 + Istio + ArgoCD | Docker Compose（一键启动） |
| 月成本 | ≥ 3,000 元 | **0 元**（Docker Compose 本地部署） |

---

## 2. 系统架构总览

### 2.1 架构全景图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         InkBloom v1 系统架构                                  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Electron 桌面应用                                   │   │
│  │  ┌────────────────────────────────────────────────────────────────┐  │   │
│  │  │  主进程（Node.js）：Go/Python 子进程管理 │ 本地文件缓存 │ 文件系统（素材库）│  │   │
│  │  └────────────────────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────────────────────┐  │   │
│  │  │  渲染进程：React + TipTap + Zustand                            │  │   │
│  │  │  左侧面板 │ 编辑器 │ AI对话 │ AIGC状态栏 │ 知识图谱            │  │   │
│  │  └────────────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│         │ HTTP/REST          │ gRPC (streaming)       │ WebSocket            │
│         ▼                    ▼                        ▼                      │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐    │
│  │  Go 主服务        │ │ Python AI 服务    │ │     NATS JetStream       │    │
│  │  (Gin + gRPC)    │◄├► (FastAPI)       │◄►│     (事件总线)           │    │
│  │                  │ │                  │ │                          │    │
│  │  · REST API      │ │  · LLM Provider  │ │  · aigc.task.created     │    │
│  │  · gRPC Server   │ │  · 图片 Provider  │ │  · aigc.task.progress    │    │
│  │  · NATS Consumer │ │  · Prompt 预制    │ │  · aigc.task.completed   │    │
│  │  · 任务引擎      │ │  · 实体/关系提取  │ │  · ai.session.event      │    │
│  │  · WebSocket Hub │ │  · 一致性检测     │ │  · knowledge.extracted   │    │
│  │  · 缓存层        │ │                  │ │                          │    │
│  └──────┬───────────┘ └──────────────────┘ └──────────────────────────┘    │
│         │                    │                                              │
│    ┌────┴────┐          ┌────┴────┐                                        │
│    │PostgreSQL│          │  Redis  │                                        │
│    │(持久存储) │          │(缓存/锁) │                                        │
│    └─────────┘          └─────────┘                                        │
│                                                                              │
│  外部服务（可选）：                                                           │
│  ├─ OpenAI / DeepSeek API（AI文本，用户配Key）                                │
│  ├─ Pollinations.ai（AI图片，免费无需Key）                                    │
│  ├─ DALL-E / Stability AI（AI图片，用户付费）                                 │
│  ├─ 本地 Stable Diffusion WebUI（AI图片，本地GPU）                            │
│  └─ 本地 Ollama（AI文本，本地免费）                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 服务间通信

```
┌─────────────────────────────────────────────────────────────────────┐
│  通信方式选择策略：                                                    │
│                                                                     │
│  HTTP/REST（同步请求）                                                │
│  ├─ 前端 → Go 服务：CRUD 操作、查询                                  │
│  └─ 特点：简单、无状态、适合请求-响应模式                              │
│                                                                     │
│  gRPC + Protobuf（高性能流式）                                        │
│  ├─ Go 服务 ↔ Python AI 服务：AI 对话流式响应                        │
│  ├─ Go 服务 → Python AI 服务：Prompt 预制、实体提取                  │
│  └─ 特点：强类型、双向流、低延迟、适合 AI 推理场景                    │
│                                                                     │
│  NATS JetStream（异步事件）                                           │
│  ├─ Go → NATS → Go：AIGC 任务创建/进度/完成                         │
│  ├─ Go → NATS → Python：AI 相关异步任务                              │
│  └─ 特点：持久化、至少一次投递、消费者组、适合事件驱动                 │
│                                                                     │
│  WebSocket（实时推送）                                                │
│  ├─ Go → 前端：任务进度、AIGC 状态、通知                              │
│  └─ 特点：全双工、低延迟、适合实时 UI 更新                            │
│                                                                     │
│  IPC（Electron 进程间）                                               │
│  ├─ 主进程 ↔ 渲染进程：文件操作、进程管理、本地存储                   │
│  └─ 特点：安全隔离、受控通信                                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 技术栈选型与理由

### 3.1 技术栈矩阵

| 层级 | 选型 | 版本 | 选型理由 | 面试亮点 |
|------|------|------|----------|----------|
| **桌面框架** | Electron | 33+ | 本地文件访问、跨平台、进程隔离 | 主进程管理 Go/Python 子进程 |
| **前端** | React 18 + TypeScript + Vite | — | 生态成熟、类型安全、HMR 快 | 组件设计模式、状态管理 |
| **编辑器** | TipTap（ProseMirror） | 2.x | 可扩展性最强、自定义 Node/Mark | 自定义 AIGC 扩展 |
| **样式** | Tailwind CSS + shadcn/ui | — | 原子化 CSS、暗色主题友好 | — |
| **状态管理** | Zustand | — | 轻量、无 boilerplate | 与 Redux 对比的选型思考 |
| **主后端** | **Go + Gin** | 1.22+ | 原生并发、编译快、部署简单 | **goroutine pool / channel 编排** |
| **AI 服务** | **Python + FastAPI** | 3.12+ | AI 生态不可替代、异步原生 | **微服务拆分决策、gRPC 流式** |
| **数据库** | **PostgreSQL** | 16+ | JSONB/CTE/窗口函数/FTS | **高级 SQL 特性、索引策略** |
| **ORM** | GORM + sqlc | — | GORM 负责写操作/简单 CRUD；sqlc 负责复杂读查询/高性能场景 | 两种 ORM 策略对比 |
| **缓存** | **Redis** | 7+ | 缓存/分布式锁/限流/发布订阅 | **Cache-Aside / 穿透防护 / 分布式锁** |
| **消息队列** | **NATS JetStream** | 2.x | 轻量高性能、持久化、消费者组 | **事件驱动架构、至少一次投递** |
| **服务通信** | **gRPC + Protobuf** | — | 强类型、流式传输、代码生成 | **Server Streaming / 背压控制** |
| **搜索** | PostgreSQL FTS + zhparser | — | 中文全文检索、零额外依赖 | **GIN/GiST 索引、分词策略** |
| **对象存储** | 本地 FS + MinIO 接口兼容 | — | 本地开发用 FS，生产可切 MinIO | **存储抽象层设计** |
| **图谱可视化** | Cytoscape.js | — | 轻量图谱、力导向布局 | — |
| **容器化** | **Docker Compose** | — | 一键启动全部服务 | **多服务编排、健康检查** |
| **CI/CD** | GitHub Actions | — | 自动测试 + 构建 + 发布 | — |
| **AI 文本** | OpenAI SDK（兼容 DeepSeek） | — | 标准接口、流式 SSE | Provider 可插拔设计 |
| **AI 文本(本地)** | Ollama | — | 本地免费、兼容 OpenAI API | — |
| **AI 图片(免费)** | Pollinations.ai | — | 无需 API Key | — |
| **AI 图片(本地)** | Stable Diffusion WebUI API | — | 本地 GPU | — |
| **AI 图片(付费)** | DALL-E / Stability AI | — | 高质量 | — |
| **图床** | SM.MS（可选） | — | 多平台粘贴需外链 | — |

### 3.2 为什么 Go + Python 双服务而非单体？

```
┌─────────────────────────────────────────────────────────────────────┐
│  决策分析：                                                           │
│                                                                     │
│  方案A：纯 Go 单体                                                   │
│  ├─ 优点：部署简单、一种语言                                         │
│  ├─ 缺点：AI/ML 库匮乏（无 transformers/sentencepiece）              │
│  └─ 结论：AI 能力受限，不展示 AI 工程能力                            │
│                                                                     │
│  方案B：纯 Python 单体                                               │
│  ├─ 优点：AI 生态完善、开发快                                       │
│  ├─ 缺点：GIL 限制 CPU 并发、不展示 Go 并发能力                      │
│  └─ 结论：无法展示高并发服务端能力                                   │
│                                                                     │
│  方案C：Go 主服务 + Python AI 服务（✅ 选择）                         │
│  ├─ 优点：各取所长、展示微服务设计、展示 gRPC 通信                    │
│  ├─ 优点：Go 处理高并发业务逻辑、Python 处理 AI 推理                  │
│  ├─ 缺点：运维复杂度增加 → Docker Compose 解决                       │
│  └─ 结论：最佳求职展示，架构合理，业界标准做法                        │
│                                                                     │
│  业界参考：                                                           │
│  ├─ 字节跳动：Go 主服务 + Python 推荐/搜索服务                       │
│  ├─ 美团：Java 主服务 + Python AI 服务                               │
│  └─ 大量 AI 公司：Go/Rust 业务层 + Python ML 层                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. 前端架构

### 4.1 工程结构

```
packages/desktop/
├── electron/
│   ├── main.ts                  # Electron 主进程：管理 Go/Python 子进程
│   ├── preload.ts               # IPC 桥接
│   └── ipc/                     # IPC 处理器
│       ├── novel-handlers.ts
│       ├── ai-handlers.ts
│       ├── aigc-handlers.ts
│       ├── task-handlers.ts
│       └── export-handlers.ts
├── src/
│   ├── components/
│   │   ├── editor/              # TipTapEditor, Toolbar, ContextMenu, DiffViewer
│   │   ├── outline/             # OutlineTree, VolumeNode
│   │   ├── panels/              # LeftPanel, RightPanel, SettingsPanel
│   │   ├── aigc/                # AIGCToolbar, TaskStatusBar, ImagePreview, AssetLibrary
│   │   ├── ai/                  # AIChatPanel, MessageBubble, ModelSelector
│   │   ├── export/              # CopyMenu, PlatformLinks, ExportDialog
│   │   └── common/              # 通用组件
│   ├── stores/                  # Zustand: novel, editor, ai, aigc, settings
│   ├── services/                # api-client, ws-client, clipboard, platform-adapter
│   └── styles/
└── package.json

packages/server/                 # Go 主服务（详见第5章）
packages/ai-service/             # Python AI 服务（详见第6章）
packages/shared/                 # Protobuf 定义 + 共享类型
```

### 4.2 TipTap 编辑器扩展

- **核心扩展**：document, paragraph, text, bold, italic, heading, list, blockquote, image, placeholder, history
- **自定义扩展**：AIGCImageNode（含生成状态标记 + Provider 元数据）、ChapterBreak（章节分隔）、CharacterMention（@角色关联知识图谱）
- **编辑器功能**：工具栏、右键菜单（含 AIGC 入口）、快捷键、选中浮动工具栏、字数统计、暗色主题

### 4.3 状态管理（Zustand Store）

```typescript
// novel-store: novels[], currentNovel, currentChapter, volumes
// editor-store: content(TipTap JSON), wordCount, isDirty, saveStatus
// ai-store: messages[], isStreaming, currentModel, availableModels
// aigc-store: tasks[], assets[], selectedProvider
//   ├── createImageTask(prompt, options) → taskId (via Go REST API)
//   ├── subscribeProgress(taskId) → WebSocket 监听
//   ├── cancelTask(taskId)
//   └── insertToEditor(assetId)
// settings-store: apiKeys, preferences, defaultProviders
```

### 4.4 WebSocket 客户端

前端通过 WebSocket 连接 Go 服务，接收实时事件：
- `task:created` / `task:progress` / `task:completed` / `task:failed` — AIGC 任务状态
- `ai:stream:chunk` — AI 对话流式输出（备用通道，主通道为 SSE）
- `notification` — 系统通知

---

## 5. Go 主服务架构

### 5.1 工程结构

```
packages/server/
├── cmd/
│   └── server/
│       └── main.go              # 入口：初始化所有组件、优雅关闭
├── internal/
│   ├── config/                  # Viper 配置加载（YAML + 环境变量）
│   ├── server/
│   │   ├── http.go              # Gin 路由注册、中间件
│   │   ├── grpc.go              # gRPC Server 启动
│   │   └── websocket.go         # WebSocket Hub（连接管理、广播）
│   ├── handler/                 # HTTP Handler（Controller 层）
│   │   ├── novel_handler.go
│   │   ├── chapter_handler.go
│   │   ├── ai_handler.go        # 代理转发到 Python AI 服务（gRPC）
│   │   ├── aigc_handler.go      # 创建 AIGC 任务 → 发布到 NATS
│   │   ├── task_handler.go
│   │   ├── knowledge_handler.go
│   │   ├── export_handler.go
│   │   └── format_handler.go
│   ├── service/                 # 业务逻辑层
│   │   ├── novel_service.go
│   │   ├── chapter_service.go
│   │   ├── task_engine/         # ★ 分布式任务引擎（详见第9章）
│   │   │   ├── engine.go        # 引擎核心：Worker Pool + 调度
│   │   │   ├── handler.go       # 任务处理器接口
│   │   │   ├── image_handler.go # 图片生成处理器
│   │   │   └── export_handler.go
│   │   ├── cache/               # ★ 缓存策略
│   │   │   ├── manager.go       # Cache-Aside 模式
│   │   │   └── keys.go          # Key 命名规范
│   │   └── ratelimit/           # ★ 限流器
│   │       ├── token_bucket.go  # 令牌桶算法
│   │       └── middleware.go    # Gin 中间件
│   ├── repository/              # 数据访问层
│   │   ├── novel_repo.go        # GORM：写操作 + 简单 CRUD
│   │   ├── chapter_repo.go      # sqlc：复杂读查询 + 高性能场景
│   │   └── ...
│   ├── middleware/               # Gin 中间件
│   │   ├── cors.go
│   │   ├── auth.go              # 简单 Token 认证
│   │   ├── logger.go            # 结构化日志（Zap）
│   │   ├── recovery.go          # Panic 恢复
│   │   ├── ratelimit.go         # 限流
│   │   └── metrics.go           # Prometheus 指标
│   ├── model/                   # GORM 模型
│   ├── dto/                     # 请求/响应 DTO
│   └── pkg/                     # 内部工具包
│       ├── breaker/             # ★ 熔断器（Hystrix 模式）
│       ├── idgen/               # 雪花 ID / UUID 生成
│       └── hasher/              # 哈希工具
├── proto/                       # Protobuf 定义（gRPC 服务）
│   ├── ai_service.proto
│   └── aigc_service.proto
├── api/                         # sqlc 生成的类型安全查询
├── migrations/                  # golang-migrate SQL 迁移
├── go.mod
└── Dockerfile
```

### 5.2 API 路由

| 方法 | 路径 | 说明 | 中间件 |
|------|------|------|--------|
| POST/GET/PUT/DELETE | `/api/v1/novels` | 小说 CRUD | auth, logger, ratelimit |
| GET | `/api/v1/novels/:id/outline` | 完整大纲树 | auth, cache(5min) |
| POST/GET/PUT | `/api/v1/chapters` | 章节管理 | auth |
| GET | `/api/v1/chapters/:id/content` | 章节内容 | auth, cache(1min) |
| POST | `/api/v1/ai/chat` | AI 对话（SSE 流式） | auth |
| POST | `/api/v1/ai/inline` | 行内续写 | auth |
| POST | `/api/v1/ai/rewrite` | 润色/扩写/缩写 | auth |
| POST | `/api/v1/aigc/generate` | 创建图片生成任务 | auth, ratelimit |
| GET | `/api/v1/aigc/tasks/:id` | 查询任务状态 | auth |
| GET | `/api/v1/aigc/assets` | 素材库列表 | auth, cache |
| POST | `/api/v1/aigc/prompt` | 上下文预制 prompt（→gRPC→Python） | auth |
| GET | `/api/v1/tasks` | 异步任务列表 | auth |
| POST | `/api/v1/knowledge/extract` | 提取实体（→gRPC→Python） | auth |
| GET | `/api/v1/knowledge/graph/:novel_id` | 获取图谱 | auth |
| POST | `/api/v1/knowledge/check` | 一致性检测（→gRPC→Python） | auth |
| POST | `/api/v1/format/convert` | 格式转换 | auth |
| POST | `/api/v1/export/markdown` | 导出 Markdown ZIP | auth |
| GET | `/ws` | WebSocket 连接 | auth |
| GET | `/health` | 健康检查 | — |
| GET | `/metrics` | Prometheus 指标 | — |

### 5.3 核心设计模式

```go
// ★ goroutine Worker Pool（任务引擎核心）
type TaskEngine struct {
    workerCount int
    taskCh      chan Task           // 有缓冲 channel 作为任务队列
    results     chan TaskResult
    db          *gorm.DB
    redis       *redis.Client
    nats        *natsconn.Conn
    breaker     *breaker.Breaker    // 外部 API 熔断器
}

func (e *TaskEngine) Start(ctx context.Context) {
    // 启动 N 个 worker goroutine
    for i := 0; i < e.workerCount; i++ {
        go e.worker(ctx, i)
    }
    // NATS 消费者：订阅 AIGC 任务主题
    sub, _ := e.nats.Subscribe("aigc.task.>", func(msg *nats.Msg) {
        task := parseTask(msg.Data)
        select {
        case e.taskCh <- task:      // 非阻塞投递
        default:
            e.handleOverflow(task)  // 队列满时持久化到 DB
        }
    })
}

func (e *TaskEngine) worker(ctx context.Context, id int) {
    for {
        select {
        case <-ctx.Done():
            return
        case task := <-e.taskCh:
            e.processTask(ctx, task) // 处理任务 + 分布式锁 + 重试
        }
    }
}

// ★ Redis 分布式锁（防止任务重复处理）
// 使用 Lua 脚本保证「验证持有者 + 释放」的原子性
const unlockScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    else
        return 0
    end
`
func (e *TaskEngine) acquireLock(ctx context.Context, taskID string) (UnlockFunc, error) {
    token := uuid.NewString()  // 唯一持有者标识
    locked := e.redis.SetNX(ctx, "lock:task:"+taskID, token, 30*time.Second)
    if !locked.Val() {
        return nil, ErrTaskAlreadyProcessing
    }
    // 看门狗：后台 goroutine 定期续期（防止长任务锁过期）
    go e.lockWatchdog(ctx, taskID, token)
    return func() {
        // Lua 原子释放：仅当锁属于当前 worker 时才删除
        e.redis.Eval(ctx, unlockScript, []string{"lock:task:" + taskID}, token)
    }, nil
}

// ★ 熔断器（保护外部 API 调用）
func (e *TaskEngine) callExternalAPI(ctx context.Context, fn func() error) error {
    return e.breaker.Execute(ctx, func(ctx context.Context) error {
        return fn()
    })
    // 熔断状态：Closed → Open(失败率>50%) → HalfOpen(定时探测) → Closed
}
```

### 5.4 优雅关闭（Graceful Shutdown）

```go
// ★ 优雅关闭流程：SIGTERM → 停止接收 → drain 进行中请求 → 关闭资源
func (s *Server) GracefulShutdown(ctx context.Context) error {
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    select {
    case <-quit:                       // 收到退出信号
    case <-ctx.Done():                 // 或 context 取消
    }

    // 1. 停止接收新请求（HTTP Server 内置支持）
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // 2. 等待进行中的 HTTP 请求完成
    s.httpServer.Shutdown(shutdownCtx)

    // 3. 停止 gRPC Server（graceful stop，等待 RPC 完成）
    s.grpcServer.GracefulStop()

    // 4. Drain NATS consumer（停止拉取新消息，等待当前消息处理完）
    s.natsConsumer.Drain()

    // 5. 关闭任务引擎（等待 worker 完成当前任务）
    s.taskEngine.Stop()

    // 6. 关闭数据库连接池
    s.db.Close()

    // 7. 关闭 Redis 连接池
    s.redis.Close()

    // 8. 关闭 NATS 连接
    s.natsConn.Close()

    return nil
}

// 使用 errgroup 编排启动和关闭
func main() {
    g, ctx := errgroup.WithContext(context.Background())
    srv := NewServer()

    g.Go(func() error { return srv.StartHTTP() })
    g.Go(func() error { return srv.StartGRPC() })
    g.Go(func() error { return srv.taskEngine.Start(ctx) })

    // 任一服务退出或收到信号 → 触发优雅关闭
    g.Go(func() error {
        <-ctx.Done()
        return srv.GracefulShutdown(context.Background())
    })

    g.Wait()  // 等待所有 goroutine 退出
}
```

### 5.5 可观测性（Observability）

```
┌─────────────────────────────────────────────────────────────────────┐
│  可观测性三件套：                                                       │
│                                                                     │
│  1. 结构化日志（Zap）：                                                  │
│     ├─ JSON 格式输出，便于日志采集和分析                                   │
│     ├─ 请求级 trace_id 注入（从 context 传播）                            │
│     └─ 中间件自动记录：method/path/status/latency/request_id            │
│                                                                     │
│  2. 指标暴露（Prometheus）：                                              │
│     ├─ /metrics 端点暴露 Prometheus 格式                                 │
│     ├─ 关键指标：http_requests_total / http_request_duration_seconds    │
│     │            task_processed_total / task_duration_seconds           │
│     │            grpc_requests_total / cache_hit_rate                   │
│     └─ 可接 Grafana 可视化（开发环境可选）                                 │
│                                                                     │
│  3. 分布式链路追踪（OpenTelemetry）：                                      │
│     ├─ Go ↔ Python 跨服务追踪（通过 gRPC metadata 传播 trace context）   │
│     ├─ 一条请求完整链路：HTTP → Go Handler → gRPC → Python → LLM API     │
│     ├─ 中间件自动注入 span：HTTP handler / gRPC interceptor / DB query   │
│     └─ 可导出到 Jaeger 本地查看（开发环境可选）                              │
│                                                                     │
│  跨服务传播示例：                                                         │
│  Go: otel.GetTextMapPropagator().Inject(ctx, metadata)                │
│  → gRPC metadata → Python: otel.GetTextMapPropagator().Extract()      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Python AI 服务架构

### 6.1 工程结构

```
packages/ai-service/
├── app/
│   ├── main.py                  # FastAPI 入口 + gRPC Server 启动
│   ├── config.py                # Pydantic Settings
│   ├── grpc_server/             # gRPC 服务实现
│   │   ├── ai_servicer.py       # AI 对话 gRPC（Server Streaming）
│   │   └── aigc_servicer.py     # AIGC 相关 gRPC
│   ├── llm/                     # LLM Provider 层
│   │   ├── base.py              # BaseLLMProvider 抽象
│   │   ├── openai_provider.py   # OpenAI/DeepSeek（兼容 OpenAI API）
│   │   └── ollama_provider.py   # 本地 Ollama
│   ├── aigc/                    # AIGC 图片 Provider
│   │   ├── base.py              # BaseImageProvider 抽象
│   │   ├── pollinations.py      # 免费默认
│   │   ├── local_sd.py          # 本地 Stable Diffusion
│   │   └── dalle.py             # OpenAI DALL-E
│   ├── prompt/                  # Prompt 工程
│   │   ├── builder.py           # 上下文组装 + Prompt 模板
│   │   ├── image_prompt.py      # 图片 Prompt 预制（上下文→英文描述）
│   │   └── templates/           # Prompt 模板文件
│   ├── knowledge/               # 知识图谱 AI 服务
│   │   ├── entity_extractor.py  # LLM 实体提取（结构化输出）
│   │   ├── relation_extractor.py# LLM 关系提取
│   │   └── consistency_checker.py# 一致性检测
│   └── utils/
│       ├── token_counter.py     # Token 计数 + 预算管理
│       └── retry.py             # 重试装饰器
├── proto/                       # 共享 Protobuf 定义（符号链接或复制）
├── requirements.txt
└── Dockerfile
```

### 6.2 gRPC 服务定义

```protobuf
// proto/ai_service.proto
syntax = "proto3";
package aiservice;

service AIService {
  // 流式对话：Go → Python，Server Streaming
  rpc ChatStream(ChatRequest) returns (stream ChatChunk);
  // 同步调用：行内续写、润色等
  rpc ChatComplete(ChatRequest) returns (ChatResponse);
  // 图片 Prompt 预制
  rpc GenerateImagePrompt(ImagePromptRequest) returns (ImagePromptResponse);
  // 实体提取
  rpc ExtractEntities(ExtractRequest) returns (EntityResponse);
  // 关系提取
  rpc ExtractRelations(RelationRequest) returns (RelationResponse);
  // 一致性检测
  rpc CheckConsistency(ConsistencyRequest) returns (ConsistencyResponse);
}

message ChatRequest {
  repeated Message messages = 1;
  string model = 2;
  float temperature = 3;
  int32 max_tokens = 4;
  map<string, string> context = 5;  // 上下文元数据
}

message ChatChunk {
  string content = 1;
  string finish_reason = 2;
  Usage usage = 3;
}
```

### 6.3 gRPC 中间件链（拦截器）

```go
// ★ gRPC UnaryInterceptor 链式编排（Go 端调用 Python 服务时）
func chainUnaryInterceptors(interceptors ...grpc.UnaryClientInterceptor) grpc.UnaryClientInterceptor {
    return func(ctx context.Context, method string, req, reply interface{},
        cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
        // 链式执行：Auth → Logging → Tracing → Retry
        return grpc.ChainUnaryInterceptor(interceptors...)(ctx, method, req, reply, cc, invoker, opts...)
    }
}

// 链路追踪拦截器（自动传播 trace context 到 Python 服务）
func tracingInterceptor() grpc.UnaryClientInterceptor {
    return func(ctx context.Context, method string, req, reply interface{},
        cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
        // OpenTelemetry 自动注入 trace context 到 gRPC metadata
        return otelgrpc.UnaryClientInterceptor()(ctx, method, req, reply, cc, invoker, opts...)
    }
}

// Python 端同样配置 gRPC ServerInterceptor：
# - AuthInterceptor: 验证调用方 Token
# - LoggingInterceptor: 记录 method/duration/status
# - TracingInterceptor: 提取 trace context + 创建 span
```

### 6.4 为什么 Python 不做主服务？

| 维度 | Go | Python |
|------|-----|--------|
| 并发模型 | goroutine（M:N 调度，百万级） | asyncio（I/O 并发高效，CPU 密集型受 GIL 限制） |
| HTTP 性能 | Gin ~10万 QPS（简单基准）/ 业务 ~5000-10000 | FastAPI ~1万 QPS（简单基准）/ 业务 ~2000-5000 |
| 内存占用 | ~10MB 基础 | ~50MB 基础 |
| AI 生态 | 有限 | 丰富（transformers, numpy, PIL） |
| 部署 | 单二进制，零依赖 | 需 pip 环境 |
| **结论** | **适合高并发业务逻辑** | **适合 AI 推理** |

---

## 7. 数据层设计

### 7.1 PostgreSQL Schema

```sql
-- 小说表
CREATE TABLE novels (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    genre VARCHAR(100),
    description TEXT,
    cover_image VARCHAR(500),
    word_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    metadata JSONB DEFAULT '{}',         -- 扩展属性
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_novels_status ON novels(status) WHERE deleted_at IS NULL;

-- 卷表
CREATE TABLE volumes (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    title VARCHAR(255) NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_volumes_novel ON volumes(novel_id, position);

-- 章节表
CREATE TABLE chapters (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    volume_id BIGINT REFERENCES volumes(id),
    title VARCHAR(255) NOT NULL,
    content TEXT,
    content_json JSONB,                  -- TipTap JSON AST
    word_count INTEGER DEFAULT 0,
    position INTEGER NOT NULL,
    summary TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_chapters_novel ON chapters(novel_id, position);

-- 设定表（metadata 用 JSONB 存储灵活属性）
CREATE TABLE settings (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    content TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 角色表
CREATE TABLE characters (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100),
    brief TEXT,
    appearance TEXT,
    background TEXT,
    personality TEXT,
    goals TEXT,
    abilities TEXT,
    avatar_path VARCHAR(500),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- AI 会话 & 消息
CREATE TABLE ai_sessions (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT REFERENCES novels(id),
    session_type VARCHAR(50),
    model VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ai_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES ai_sessions(id),
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    token_input INTEGER,
    token_output INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ai_messages_session ON ai_messages(session_id, created_at);

-- ★ 异步任务表（分布式任务引擎持久化）
CREATE TABLE tasks (
    id VARCHAR(36) PRIMARY KEY,          -- UUID
    type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    priority SMALLINT DEFAULT 1,
    payload JSONB,                       -- 任务参数
    result JSONB,                        -- 任务结果
    progress SMALLINT DEFAULT 0,
    error_msg TEXT,
    retry_count SMALLINT DEFAULT 0,
    max_retries SMALLINT DEFAULT 3,
    idempotency_key VARCHAR(64) UNIQUE,  -- ★ 幂等键（防重复处理）
    novel_id BIGINT,
    chapter_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_tasks_status ON tasks(status, priority DESC, created_at)
    WHERE status IN ('pending', 'running');

-- ★ 素材资源表
CREATE TABLE assets (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT REFERENCES novels(id),
    chapter_id BIGINT REFERENCES chapters(id),
    task_id VARCHAR(36) REFERENCES tasks(id),
    file_path VARCHAR(500) NOT NULL,
    thumbnail_path VARCHAR(500),
    prompt TEXT,
    provider VARCHAR(50),
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    confirmed BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 知识图谱节点
CREATE TABLE knowledge_nodes (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),                    -- character/location/organization/skill
    properties JSONB DEFAULT '{}',
    source_chapter_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_knowledge_nodes_novel ON knowledge_nodes(novel_id, type);
CREATE UNIQUE INDEX idx_knowledge_nodes_unique ON knowledge_nodes(novel_id, name, type);

-- 知识图谱边
CREATE TABLE knowledge_edges (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    source_id BIGINT NOT NULL REFERENCES knowledge_nodes(id),
    target_id BIGINT NOT NULL REFERENCES knowledge_nodes(id),
    relation_type VARCHAR(100),
    description TEXT,
    source_chapter_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_knowledge_edges_unique
    ON knowledge_edges(novel_id, source_id, target_id, relation_type);

-- ★ PostgreSQL 全文搜索（中文：zhparser 分词）
-- 需安装 zhparser 扩展：CREATE EXTENSION zhparser;
CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION chinese
    ADD MAPPING FOR n,v,a,i,e,l WITH simple;

-- 全文搜索索引（通过触发器自动维护）
ALTER TABLE chapters ADD COLUMN content_tsv tsvector;
CREATE INDEX idx_chapters_fts ON chapters USING GIN(content_tsv);
-- 触发器：INSERT/UPDATE 时自动更新 tsvector
CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
    ON chapters FOR EACH ROW EXECUTE FUNCTION
    tsvector_update_trigger(content_tsv, 'chinese', title, content);
```

### 7.2 Redis 数据结构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  Redis 数据规划：                                                     │
│                                                                     │
│  缓存层（Cache-Aside 模式）：                                         │
│  ├─ ink:novel:{id}            → JSON（小说详情，TTL 5min）            │
│  ├─ ink:novel:{id}:outline    → JSON（大纲树，TTL 5min）              │
│  ├─ ink:chapter:{id}:content  → JSON（章节内容，TTL 1min）            │
│  ├─ ink:assets:novel:{id}     → JSON（素材列表，TTL 5min）            │
│  └─ 缓存策略：读时加载 + 写时失效 + 空值缓存(防穿透,TTL 30s)          │
│                                                                     │
│  分布式锁：                                                           │
│  ├─ lock:task:{taskId}        → 1（TTL 30s，防任务重复处理）          │
│  └─ lock:export:{novelId}     → 1（TTL 60s，防并发导出冲突）          │
│                                                                     │
│  限流：                                                               │
│  ├─ ratelimit:aigc:{userId}   → 计数器（滑动窗口，10次/min）          │
│  └─ ratelimit:ai:{userId}     → 计数器（滑动窗口，30次/min）          │
│                                                                     │
│  任务进度（实时推送缓冲）：                                            │
│  ├─ task:progress:{taskId}    → 进度值 0-100（TTL 1h）               │
│  └─ 通过 WebSocket 推送给前端                                       │
│                                                                     │
│  会话状态：                                                           │
│  ├─ session:{token}           → userId（登录态，TTL 24h）             │
│  └─ ws:conn:{userId}          → connectionId（WebSocket 连接追踪）    │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 PostgreSQL 高级特性实战

```sql
-- ★ CTE 递归查询：获取完整大纲树（卷 → 章节层级结构）
WITH RECURSIVE outline_tree AS (
    -- 基础情况：卷
    SELECT v.id, v.title, v.position, 'volume' AS node_type,
           NULL::BIGINT AS parent_id, 0 AS depth
    FROM volumes v
    WHERE v.novel_id = $1 AND v.deleted_at IS NULL

    UNION ALL

    -- 递归：章节挂在卷下
    SELECT c.id, c.title, c.position, 'chapter' AS node_type,
           c.volume_id AS parent_id, ot.depth + 1
    FROM chapters c
    JOIN outline_tree ot ON c.volume_id = ot.id
    WHERE c.deleted_at IS NULL
)
SELECT * FROM outline_tree ORDER BY position;

-- ★ 窗口函数：章节字数排名 + 累计字数（小说进度统计）
SELECT c.id, c.title, c.word_count,
       RANK() OVER (PARTITION BY c.novel_id ORDER BY c.word_count DESC) AS word_rank,
       SUM(c.word_count) OVER (
           PARTITION BY c.novel_id ORDER BY c.position
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS cumulative_words
FROM chapters c
WHERE c.novel_id = $1 AND c.deleted_at IS NULL;

-- ★ JSONB GIN 索引：查询包含特定属性的设定（如“场景类型”的设定）
SELECT * FROM settings
WHERE novel_id = $1
  AND metadata @> '{"scene_type": "battlefield"}'  -- @> 包含操作符
  AND deleted_at IS NULL;

-- ★ JSONB 数组查询：角色能力包含“剑术”的所有角色
SELECT name, metadata->'abilities' AS abilities
FROM characters
WHERE novel_id = $1
  AND metadata->'abilities' ? '剑术'  -- ? 键存在操作符
  AND deleted_at IS NULL;
```

### 7.4 本地文件存储

```
~/.inkbloom/
├── config.yaml                  # 配置（数据库连接、Redis、NATS、API Keys）
├── novels/{novel_id}/
│   ├── assets/                  # AIGC 插图素材库
│   │   ├── {asset_id}.png
│   │   └── thumbs/{asset_id}_thumb.png
│   └── exports/                 # 导出文件
└── logs/
    ├── server.log               # Go 服务日志（JSON 格式）
    └── ai-service.log           # Python 服务日志
```

---

## 8. 消息队列与事件驱动（NATS）

### 8.1 为什么选 NATS 而非 Kafka/RabbitMQ？

| 维度 | Kafka | RabbitMQ | **NATS JetStream** |
|------|-------|----------|---------------------|
| 部署复杂度 | 高（ZK/KRaft + Broker） | 中（Erlang 运行时） | **低（单二进制）** |
| 内存占用 | ~500MB+ | ~100MB+ | **~20MB** |
| 吞吐量 | 百万级/s | 万级/s | **十万级/s** |
| 持久化 | ✅ | ✅ | ✅（JetStream） |
| 消费者组 | ✅ | ✅ | ✅ |
| 通配符订阅 | ❌ | ✅（Topic Exchange `*`/`#`） | **✅（`aigc.task.*`）** |
| 适合场景 | 大数据流 | 企业消息 | **微服务事件驱动** |

**结论**：NATS 轻量到可以嵌入个人项目，但功能足够展示事件驱动架构设计。

### 8.2 事件主题设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  NATS JetStream 主题规划：                                           │
│                                                                     │
│  aigc.task.created       → Go 任务引擎消费 → 创建图片生成任务         │
│  aigc.task.progress      → Go WebSocket Hub 消费 → 推送前端          │
│  aigc.task.completed     → Go 消费 → 更新状态 + 推送前端              │
│  aigc.task.failed        → Go 消费 → 重试/告警 + 推送前端             │
│                                                                     │
│  ai.request.chat         → Python AI 服务消费 → LLM 推理              │
│  ai.request.extract      → Python AI 服务消费 → 实体/关系提取         │
│  ai.response.complete    → Go 消费 → 处理 AI 结果                     │
│                                                                     │
│  knowledge.extracted     → Go 消费 → 更新图谱数据                     │
│  chapter.updated         → Go 消费 → 更新缓存 + 触发搜索索引          │
│                                                                     │
│  消费者组（Consumer Groups）：                                         │
│  ├─ task-engine-group      → 竞争消费，每个任务只处理一次              │
│  ├─ notification-group     → 广播消费，所有实例都收到通知              │
│  └─ 至少一次投递 + 幂等键 → 保证不丢不重                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.3 Go 端 NATS 集成

```go
// NATS 连接 + JetStream 上下文
nc, _ := nats.Connect(cfg.NATS.URL)
js, _ := nc.JetStream()

// 创建持久化 Stream
js.AddStream(&nats.StreamConfig{
    Name:     "AIGC_TASKS",
    Subjects: []string{"aigc.task.>"},
    Retention: nats.WorkQueuePolicy,
})

// 发布事件
js.Publish("aigc.task.created", taskJSON)

// 消费者组（竞争消费）
js.Subscribe("aigc.task.created", func(msg *nats.Msg) {
    task := parseTask(msg.Data)
    engine.Process(task)
    msg.Ack()  // 处理成功确认
}, nats.Durable("task-engine-group"), nats.ManualAck())
```

---

## 9. 分布式任务引擎

### 9.1 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                    分布式任务引擎（Go TaskEngine）                     │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────┐      │
│  │ NATS     │───►│ 调度器        │───►│  Worker Pool          │      │
│  │ Consumer │    │ (优先级排序)   │    │  (goroutine pool)     │      │
│  └──────────┘    └──────────────┘    │  ┌────┐┌────┐┌────┐  │      │
│                                       │  │ W1 ││ W2 ││ W3 │  │      │
│  ┌──────────┐    ┌──────────────┐    │  └────┘└────┘└────┘  │      │
│  │ Redis    │◄──►│ 分布式锁      │    │  ┌────┐┌────┐┌────┐  │      │
│  │ 分布式锁  │    │ (防重复处理)   │    │  │ W4 ││ W5 ││ W6 │  │      │
│  └──────────┘    └──────────────┘    │  └────┘└────┘└────┘  │      │
│                                       └──────────────────────┘      │
│  ┌──────────┐    ┌──────────────┐                                   │
│  │ 熔断器   │    │ 重试策略      │    ┌──────────────────────┐      │
│  │(Breaker) │    │ (指数退避)    │───►│  NATS 事件发布        │      │
│  └──────────┘    └──────────────┘    │  (progress/complete)  │      │
│                                       └──────────────────────┘      │
│  ┌──────────┐                                                       │
│  │PostgreSQL│  ← 任务状态持久化 + 幂等键                              │
│  └──────────┘                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.2 核心流程

```
任务创建：
  1. HTTP 请求 → Go Handler → 生成 UUID + 幂等键
  2. 写入 PostgreSQL tasks 表（status=pending）
  3. 发布 NATS 事件 aigc.task.created
  4. 返回 taskID 给前端

任务处理：
  1. NATS Consumer 消费 → 尝试 Redis 分布式锁
  2. 获取锁成功 → 更新 status=running → 路由到 Handler
  3. Handler 调用外部 API（经熔断器保护）
  4. 更新 progress → 发布 NATS aigc.task.progress
  5. 完成 → 更新 status=success → 发布 NATS aigc.task.completed
  6. 失败 → retry_count < max → 指数退避重新入队
  7. 重试耗尽 → status=failed → 发布 NATS aigc.task.failed

幂等保证：
  - 每个任务有 idempotency_key（基于 payload 哈希）
  - 处理前检查 PostgreSQL 是否已存在相同 key 的成功记录
  - Redis 锁 + DB 唯一约束双重保障
```

### 9.3 Outbox Pattern（可靠事件发布）

```
┌─────────────────────────────────────────────────────────────────────┐
│  问题：如何保证「DB 写入 + NATS 事件发布」的原子性？                       │
│                                                                     │
│  场景：创建任务时，需要同时写入 tasks 表 + 发布 NATS 事件                  │
│  风险：DB 写入成功但 NATS 发布失败 → 任务永远不被消费                      │
│                                                                     │
│  解决方案：Outbox Pattern                                              │
│  ┌───────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │ 同一事务内：   │    │ Publisher    │    │ NATS         │          │
│  │ 1. 写 tasks  │    │ Goroutine    │    │              │          │
│  │ 2. 写 outbox │──►│ 轮询 outbox  │──►│ 发布事件      │          │
│  │ (同一 DB 事务) │    │ 成功后删除    │    │              │          │
│  └───────────────┘    └──────────────┘    └──────────────┘          │
│                                                                     │
│  保证：DB 写入和事件记录在同一事务，要么都成功要么都失败                  │
│  最终一致性：Publisher 异步投递，失败重试，保证事件最终发出                │
└─────────────────────────────────────────────────────────────────────┘
```

```sql
-- Outbox 表（与 tasks 在同一数据库）
CREATE TABLE outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,     -- 如 'aigc.task.created'
    payload JSONB NOT NULL,               -- 事件内容
    status VARCHAR(20) DEFAULT 'pending', -- pending / published / failed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_status ON outbox(status, created_at)
    WHERE status = 'pending';

-- 任务创建时同一事务写入
BEGIN;
INSERT INTO tasks (id, type, status, payload) VALUES ($1, 'image_gen', 'pending', $2);
INSERT INTO outbox (event_type, payload) VALUES ('aigc.task.created', $3);
COMMIT;  -- 原子性保证
```

```go
// ★ Publisher Goroutine：轮询 outbox → 发布 NATS → 标记完成
func (p *OutboxPublisher) Start(ctx context.Context) {
    ticker := time.NewTicker(100 * time.Millisecond)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            events := p.fetchPending(ctx, 50)  // 批量取 50 条
            for _, event := range events {
                err := p.nats.Publish(event.EventType, event.Payload)
                if err != nil {
                    p.markFailed(event.ID)  // 失败重试
                    continue
                }
                p.markPublished(event.ID)  // 成功标记
            }
        }
    }
}
```

### 9.4 面试深聊点

| 话题 | 展示能力 |
|------|----------|
| goroutine pool + channel 编排 | Go 并发编程深度 |
| Redis 分布式锁（SETNX + TTL + Lua 释放） | 分布式系统协调 |
| 幂等键设计（payload 哈希 + DB 唯一约束） | 分布式事务理解 |
| 熔断器三态（Closed/Open/HalfOpen） | 服务韧性设计 |
| NATS 至少一次投递 + 消费端幂等 | 消息队列可靠性 |
| 指数退避重试 + 死信队列 | 容错处理 |
| Worker 优雅关闭（context 传播 + drain） | 生产级工程素养 |

---

## 10. AI 文本引擎

### 10.1 LLM Provider 可插拔架构（Python 端实现）

```python
# BaseLLMProvider 抽象接口
class BaseLLMProvider(ABC):
    async def chat(self, messages, model, temperature, max_tokens) -> LLMResponse
    async def stream(self, messages, ...) -> AsyncIterator[LLMChunk]
    async def count_tokens(self, text, model) -> int

# 实现
class OpenAIProvider(BaseLLMProvider):
    # 兼容 OpenAI API 的所有供应商（OpenAI、DeepSeek、智谱等）
    # 用户配置 base_url + api_key

class OllamaProvider(BaseLLMProvider):
    # 本地 Ollama（http://localhost:11434/v1），免费
```

### 10.2 上下文构建（Go 端组装 → gRPC → Python 推理）

```
Go 端上下文构建：
  1. 查询当前章节内容（PostgreSQL）
  2. 查询章节摘要
  3. PostgreSQL FTS 匹配相关设定（最多5条）
  4. 查询相关角色卡（最多5个）
  5. Token 预算控制（< 4000 tokens）
  6. 组装 messages → gRPC ChatStream → Python

Python 端处理：
  1. 接收 messages + context
  2. 选择 Provider（OpenAI/Ollama）
  3. 流式调用 LLM API
  4. 通过 gRPC Server Streaming 逐 chunk 返回
  5. Go 端接收 → WebSocket 推送前端 / SSE 返回
```

### 10.3 AI 功能矩阵

| 功能 | 触发方式 | 说明 |
|------|----------|------|
| 自由对话 | 右侧 AI 面板 | 多轮对话 + 流式响应 |
| 行内续写 | Ctrl+Space | 光标位置续写 → Diff 展示 |
| 润色/扩写/缩写/去AI味 | 选中文本 → 右键 | 选中操作 → Diff 展示 → 接受/拒绝 |
| 命名生成器 | AI 工具箱 | 题材+风格 → 名字列表 |
| 章节标题生成器 | AI 工具箱 | 章节内容 → 5个标题建议 |
| 角色设定生成器 | AI 工具箱 | brief → 完整角色卡 |
| 情节建议器 | AI 工具箱 | 当前情节 → 3种发展方向 |

---

## 11. AIGC 图片生成系统

### 11.1 多 Provider 可插拔架构（Python 端）

```python
class BaseImageProvider(ABC):
    async def generate(self, prompt, width, height, style) -> ImageResult
    async def is_available(self) -> bool
    def get_supported_sizes(self) -> list

class PollinationsProvider(BaseImageProvider):
    # 免费默认 · 无需 API Key
    # URL: https://image.pollinations.ai/prompt/{prompt}?width=&height=&seed=

class LocalSDProvider(BaseImageProvider):
    # 本地 Stable Diffusion WebUI API
    # URL: http://localhost:7860/sdapi/v1/txt2img

class OpenAIDallEProvider(BaseImageProvider):
    # 付费 · 用户配置 Key
    # URL: https://api.openai.com/v1/images/generations

# Provider 选择策略：默认 Pollinations → 用户切换 → 失败自动降级
```

### 11.2 触发机制

- **右键菜单**：选中段落/光标定位 → 右键"生成插图" → Prompt 编辑框（自动预制）→ 生成
- **侧边工具栏**：AIGC 图标 → 图片生成面板 → 手动/自动 prompt → 配置参数 → 生成
- **边写边生成**：每 N 字（如 500 字）或段落完成 → 自动提取上下文 → 后台静默生成 → 状态栏通知

### 11.3 Prompt 自动预制

1. Go 端提取上下文：章节内容（光标前后 500 字）+ 摘要 + 关联设定 + 关联角色
2. gRPC 调用 Python `GenerateImagePrompt` → LLM 生成英文 prompt
3. 返回前端展示给用户编辑确认
4. 确认后提交生成任务 → Go 任务引擎 → NATS → Worker → Python 图片 Provider

---

## 12. AIGC 视频生成系统（远期预留）

与图片生成共享分布式任务引擎框架，仅扩展 Provider 接口（BaseVideoProvider）。预留扩展点：RunwayML、Pika、Kling（快影）、本地视频模型。当前状态：接口预留，不实现。tasks 表已支持 `type='video_gen'`。

---

## 13. 多平台格式转换系统

### 13.1 格式转换引擎（Go 端实现）

```
TipTap JSON → FormatEngine（遍历 AST）→ 对应 Renderer 输出

├── MarkdownRenderer    → 标准 Markdown
├── HTMLRenderer        → 标准 HTML（带 class）
├── WechatRenderer     → 微信公众号 HTML（内联 CSS、图片 base64/图床）
├── ZhihuRenderer      → 知乎 HTML（标准标签 + 代码块高亮）
├── ToutiaoRenderer    → 头条 HTML（简化标签）
├── QidianRenderer     → 起点 TXT（纯文本 + 章节分隔）
└── ClipboardRenderer  → 通用富文本（直接粘贴）
```

### 13.2 平台适配策略

- **微信公众号**（最复杂）：CSS 全内联、图片上传图床替换 URL、默认字体、`<section>` + margin 段落间距
- **知乎**：标准 HTML、代码块 `language-` 前缀、支持 LaTeX、图片外链
- **头条**：简化 HTML、去除自定义标签、图片外链
- **起点/网文**：纯文本、`第X章 标题` 格式、段落空行分隔

### 13.3 一键复制工作流

点击"复制到 XX 平台" → Go 端 FormatEngine 转换 → 图片处理（上传 SM.MS 图床/base64）→ 返回前端 → 写入剪贴板（text/html + text/plain）→ Toast 提示 → 可选"打开 XX 平台"按钮

---

## 14. 知识图谱

- **实体提取**：Go 调用 Python gRPC `ExtractEntities` → LLM 结构化输出 → 写入 knowledge_nodes → 同名合并
- **关系提取**：Go 调用 Python gRPC `ExtractRelations` → 写入 knowledge_edges → 去重
- **可视化**：Cytoscape.js，节点按类型着色（角色蓝/地点绿/组织黄/技能红），拖拽缩放点击查看详情
- **一致性检测**：Go 调用 Python gRPC `CheckConsistency` → LLM 检测矛盾 → 冲突列表提示
- **知识库集成**：AI 对话自动注入相关设定/角色 | 图片 Prompt 预制注入视觉描述 | 编辑器 @角色名弹出角色卡

---

## 15. 泛用功能设计

### 15.1 平台跳转入口

顶部导航下拉菜单：微信公众号 | 知乎创作者 | 今日头条 | 起点作家中心 | 简书 | 掘金 | [自定义平台]。点击在默认浏览器打开。

### 15.2 知识库调用与 AIGC 辅助提示

- AI 对话时自动检索相关设定/角色（PostgreSQL FTS）→ 注入上下文
- 图片 Prompt 预制时自动注入角色外貌、场景描述
- 编辑器中 @角色名 → 弹出角色卡浮窗 | #设定名 → 弹出设定浮窗

---

## 16. 安全与隐私

- **API Key**：本地 config.yaml 存储，Go 端加密读取，前端密码输入框不明文
- **数据隐私**：全部本地存储（PostgreSQL/Redis/NATS 均本地），无遥测/追踪
- **输入安全**：前端 DOMPurify 清理富文本（防 XSS），Go 端参数校验（gin binding + validator）
- **限流防护**：Redis 滑动窗口限流，防止 API 滥用
- **认证**：简单 Token 认证（本地应用，无需 OAuth）

---

## 17. 部署策略与性能指标

### 17.1 Docker Compose 一键部署

```yaml
# docker-compose.yml 架构概览
services:
  desktop:     # Electron 桌面应用（用户本地运行）
  server:      # Go 主服务（Gin + gRPC + NATS Consumer）
  ai-service:  # Python AI 服务（FastAPI + gRPC Server）
  postgres:    # PostgreSQL 16
  redis:       # Redis 7
  nats:        # NATS JetStream
```

### 17.2 也支持传统部署

- **开发模式**：`docker compose up` 一键启动全部服务（推荐，功能完整）
- **纯本地模式**：Electron 安装包内嵌 Go/Python 二进制 + SQLite 替代 PostgreSQL + 内嵌轻量 Redis/NATS（适合无 Docker 环境，功能有裁剪）
- **自动更新**：electron-updater + GitHub Releases

### 17.3 性能指标

| 指标 | 目标值 | 关键优化 |
|------|--------|----------|
| 编辑器响应 | < 100ms | 前端防抖 + 本地缓存 |
| API 响应（P99） | < 200ms | Redis 缓存 + PostgreSQL 索引 |
| AI 首字响应 | < 2s | gRPC 流式 + 连接池 |
| 图片生成 | < 30s | 异步任务 + 多 Provider |
| 应用启动 | < 3s | Go 编译二进制 + 延迟初始化 |
| Go 服务内存 | < 100MB | goroutine 复用 |
| 总内存占用 | < 1GB | 全部服务合计 |
| 安装包体积 | < 200MB | UPX 压缩 |
| Go API QPS | > 5000 | 压测验证（单机） |

### 17.4 成本分析

| 项目 | 成本 |
|------|------|
| 核心功能（编辑+导出+本地存储） | **0 元** |
| Docker Compose 本地部署 | **0 元** |
| AI 文本（Pollinations 免费图片 + 本地 Ollama） | **0 元** |
| AI 文本（DeepSeek API，可选） | ~10 元/月 |
| AI 图片（DALL-E，可选） | ~20 元/月 |
| **总计（零成本模式）** | **0 元/月** |
| **总计（增强模式）** | **~30 元/月** |

### 17.5 测试策略

```
┌─────────────────────────────────────────────────────────────────────┐
│  测试金字塔：                                                         │
│                                                                     │
│  1. 单元测试（Go 表驱动测试）：                                          │
│     ├─ 每个 service/repository 函数都有表驱动测试                       │
│     ├─ 使用 testify 断言库 + subtest 组织用例                          │
│     └─ 示例：TestNovelService_Create(t *testing.T)                   │
│                                                                     │
│  2. 集成测试（testcontainers-go）：                                     │
│     ├─ 自动启动 PostgreSQL/Redis/NATS 容器                            │
│     ├─ 测试真实 DB 交互（非 mock）：迁移 + 查询 + 事务                  │
│     ├─ 测试 NATS 事件发布/消费完整流程                                 │
│     └─ CI 中自动运行，测试完自动销毁容器                               │
│                                                                     │
│  3. Mock 生成（mockgen）：                                              │
│     ├─ gRPC client mock（测试 Go 调用 Python 服务的错误场景）          │
│     ├─ repository mock（测试 service 层逻辑，隔离 DB）                  │
│     └─ NATS client mock（测试事件发布逻辑）                             │
│                                                                     │
│  4. HTTP 测试（httptest）：                                             │
│     ├─ 每个 Handler 的请求/响应测试                                     │
│     ├─ 中间件测试（认证、限流、日志）                                   │
│     └─ SSE 流式响应测试                                                │
│                                                                     │
│  5. 前端测试（Vitest + React Testing Library）：                        │
│     ├─ 组件单元测试（Zustand store + 组件渲染）                         │
│     ├─ TipTap 编辑器扩展测试                                          │
│     └─ 格式转换引擎测试（各 Renderer 输出验证）                         │
│                                                                     │
│  6. 压测（k6 / hey）：                                                  │
│     ├─ Go API 基准测试：验证 QPS > 5000（单机）                         │
│     ├─ 任务引擎并发测试：模拟 100 并发任务处理                           │
│     └─ WebSocket 连接测试：模拟 500 并发连接                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

> **文档信息**
> - 版本：v1.0
> - 状态：自媒体 AIGC 图文工具技术方案（求职亮点版）
> - 更新时间：2026-07-14
> - 核心亮点：Go 高并发 + Python AI + 分布式就绪 + 事件驱动
> - 适用对象：个人开发者、求职者（展示服务端深度 + AI 编程融合力）
