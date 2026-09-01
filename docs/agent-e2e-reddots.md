# Agent 系统端到端测试 · 红点记录

> 测试时间：2026-08-30（基于会话 commit `29e358b` 状态）
> 测试方式：本地后端 `127.0.0.1:8080` 直连 API（`POST /api/v1/agent/chat`）+ 数据库/接口回查
> 模型：DeepSeek（thinking 模式，已验证 `reasoning_content` 多轮回传正常，无 400）
> 测试账号：13800000000 / inkbloom123（本地模式 userID=1）

## 一、测试结论速览

| 项 | 结果 |
| --- | --- |
| Agent 自主建小说+建章+写正文 | ✅ 通过（用例 1，5 次工具调用） |
| Agent 规划大纲并落库 | ✅ 通过，落库形状合法（SHAPE_OK=True） |
| 前端崩溃（原缺陷） | ✅ 已修复（后端归一化 + 前端 shape 收敛 + ErrorBoundary 三层防御就位） |
| 不存在的小说/章节 错误路径 | ✅ 优雅降级，Agent 正常向用户汇报 |
| 记忆去重 | ✅ 按 name 幂等，重复写入返回 `saved:0` |
| 大纲跨轮去重 | ⚠️ **红点 R1**：标题措辞不同会产生重复幕 |
| 章节指代歧义 | ⚠️ **红点 R2**：用户以"第N章/章节ID"口吻指代时，Agent 误建垃圾章节 |
| handler 路由注释 | ✅ **R3 已修复**（commit 0c137c0） |
| reasoning_content 多 tool_call 回传 | ✅ **R4 已修复**（commit 0c137c0，novel 34 多轮验证） |

## 二、红点清单

### 🔴 R1 — 大纲跨轮产生重复幕（中等）
- **现象**：对 novel 38 第二次 `save_outline`（幕标题 `初入江湖`/`风波渐起`/`巅峰对决`），未与已有的 `第一幕《初入江湖》`/`第二幕《风波渐起》`/`第三幕《巅峰对决》` 合并，落库后大纲出现 **6 个幕（3 对语义重复）**。
- **证据**：E2E 用例 2 + `GET /api/v1/novels/38/outline` → acts count=6，其中 act[0..2] 带"第一幕《》"前缀、act[3..5] 无前缀，节点内容一致。
- **根因**：`internal/service/outline_normalize.go` 的 `mergeOutlineAct`（:157）按 `outlineTitleKey`（仅折叠空白，`outline_normalize.go:191`）做**精确标题匹配**。LLM 在不同轮次对幕标题措辞不一致（"第一幕《初入江湖》" vs "初入江湖"），key 不同 → 判定为新幕 → 追加。
- **影响**：大纲面板展示重复幕、数据膨胀；多轮"重新规划大纲"会让幕无限增长。
- **建议修复**：在 `outlineTitleKey` 中剥离装饰性前缀（正则去掉 `^(第[一二三四五六七八九十百千0-9]+幕|Act\s*\d+|卷[一二三四五六七八九十]+)\s*[《「]?` 与结尾 `》」`），使"第一幕《初入江湖》"与"初入江湖"归并；或改为按序号/顺序合并。最低风险方案是前者。

### 🔴 R2 — 章节指代歧义导致误建垃圾章节（中等）
- **现象**：用户说"给小说38的**章节 999999** 写一段正文"，Agent 把 `999999` 当成**标题**，新建了章节 `第999999章`（chapter_id=72）并向其写入 323 字，而非写入/报错"找不到章节 999999"。
- **证据**：E2E 用例 B → tool 序列 `list_novels → create_chapter("第999999章") → write_chapter(chapter_id=72)`。
- **根因**：工具契约里 `write_chapter` 需要数字 `chapter_id`（用户根本不知道），而系统**没有任何"按标题/序号定位章节"的工具**；LLM 只能把用户口中的编号臆测成标题并先 `create_chapter`。`create_chapter` 对"标题"无唯一性约束，故重复建章不会报错。
- **影响**：用户本意"写进已有章节"被静默变成"新建章节"，产生垃圾章节、数据误导。
- **建议修复**：(a) 新增 `list_chapters(novel_id)` / `get_chapter_by_title` 工具让 Agent 先定位；(b) 或在 `write_chapter` 未提供 `chapter_id` 时强制要求先 `create_chapter`（已有），但对"用户明确说第N章"的场景，应让 Agent 先查章节列表再决定，而不是直接拿编号当标题。

### 🟡 R3 — agent_handler 注释路由错误（低/文档）
- **现象**：`internal/handler/agent_handler.go:21` 注释写 `POST /api/v1/ai/agent/chat`，但实际注册在 `internal/server/Http.go:468` 为 `aiGroup.POST("/agent/chat", ...)`，即真实路径是 `POST /api/v1/agent/chat`（无 `ai/` 段）。
- **证据**：首次以 `/api/v1/ai/agent/chat` 请求返回 `404 page not found`；改为 `/api/v1/agent/chat` 后 200。
- **影响**：仅文档/对接误导，不影响功能。
- **建议修复**：订正注释为 `/api/v1/agent/chat`。
- **状态**：✅ 已修复（commit 0c137c0，agent_handler.go:21 注释改为 `/api/v1/agent/chat`）。

### 🟡 R4 — reasoning_content 在单响应多 tool_call 时被重复挂载（低/潜在）
- **现象**：`internal/service/agent_service.go:189-211`，当一次 LLM 响应含 N 个 tool_calls 且 `resp.ReasoningContent != ""` 时，循环为每个 tool_call 各生成一条 assistant 消息，每条都带同一份 `reasoning_content`。
- **证据**：代码审查。`Run` 在 189 行 `for _, tc := range resp.ToolCalls`，209 行在循环内把 `reasoning_content` 挂到每条 assistant 消息。
- **影响**：冗余 token；个别模型对"多条 assistant tool-call 消息各带相同 reasoning"可能容忍也可能报错（DeepSeek 在用例 1 中正常）。
- **建议修复**：`reasoning_content` 仅挂到第一条 assistant 消息，或改为 OpenAI 标准写法（一条 assistant 消息包含所有 tool_calls + 一次 tool 结果回传）。
- **状态**：✅ 已修复（commit 0c137c0）。`Run` 循环改为构建**单条** assistant 消息承载本轮全部 tool_calls，`reasoning_content` 仅挂一次；novel 34 上多轮 Agent 调用（含 `save_outline` / 多工具）验证通过，DeepSeek 无 400。

## 三、已澄清的"假红点"（先前误报，本次复核纠正）

- **F1「create_novel 复用已有小说 38」**：❌ 不成立。`NovelService.CreateNovel`（`novel_service.go:53`）走 `novelRepo.Create` 插入新行。novel 38 的 `created_at=2026-09-01T08:22:10` 正是本 Agent 在上一轮 E2E 中新建的，并非"复用/改名旧小说"。
- **F2「save_memory 重复调用致数据重复」**：❌ 已缓解。`syncMemory`（`agent_service.go:410`）按 `name` 去重，相同项重跑返回 `saved:0`（用例 C1/C2 实测）。LLM 偶发重复调用不会污染数据。

## 四、测试产生的脏数据（可选清理）
- novel 38 大纲：6 个幕（3 对重复，R1 的证据），如需可重置为 3 幕。
- novel 38 章节：chapter_id=72 标题"第999999章"（R2 的证据，垃圾章节），建议 `DELETE`。
- novel 38 记忆：含 `小测`/`风雪客栈`/`江湖如代码`（来自前期 E2E，去重正常）。
- 如需清理可告知，我用 API/脚本重置 novel 38 的测试态。

## 五、验证状态
- 后端归一化：`normalizeOutlineActsJSON` + `syncOutline` 已就位，脏数据入参不会落脏（PUT 脏→GET 净，前期已验）。
- 前端防御：`outline-client.ts` 的 `normalizeOutlineActs`/`fetchOutline` 收敛形状；`ErrorBoundary`（LeftPanel.tsx:78，`resetKey={currentNovelId}`）包住大纲面板；`outline-store.ts` 应用归一化。**Agent→前端链路在脏数据下不会白屏。**
- 未覆盖：前端对 novel 38 的实际渲染（web dev server 当时未起）+ 真人多轮对话 UI 串联；建议起 web 后人工过一遍"Agent 建大纲→切到大纲 Tab"确认无白屏。

## 六、2026-09-01 更新：R3/R4 已修复 + novel 34 复现 R1/R2

### 6.1 修复落地
- R3、R4 已提交 **commit 0c137c0**。fixed build 已在 `:8080` 运行（注：cloud 模式下 NATS JetStream workqueue consumer 不允许双实例，故先杀旧实例再起新实例，单实例运行）。
- 验证方式：直连 `:8080` 对 novel 34 跑多轮 Agent 调用，reasoning 正常回传、无 400。

### 6.2 用真实已有小说「芙宁娜余生百年」(novel 34) 复现
基线：18 章、outline 空、memory 2 项。
- **R1 复现（确认）**：第一次 `save_outline`（3 幕，带"第一幕《》"前缀）→ 3 幕；第二次规划（去掉前缀，`神陨之后` 等）→ 大纲变 **6 幕**（3 原 + 3 近重复）。R1 在真实已有小说上同样发生。
- **R2 复现（更严重）**：
  - 正向（明确引用 ch 48《余生长歌》）：Agent 正确 `write_chapter(48)` 扩写 284 字 ✅ —— 引用清晰时 Agent 能正确处理已有小说。
  - 负向（引用不存在 ch 9999）：Agent 先 `write_chapter(9999)` 失败 → **静默 `create_chapter(75 「终章·余生百年」)`** → 向其写入 1100+ 字 → 触发 maxSteps 停止。即"写到指定章节"被静默篡改为"新建章节并写入"，并产生垃圾章节 75。
- **结论**：Agent 对已有小说"能写但会误造/覆盖"，**R2 是最危险的一项**（静默误造 + 覆盖）。

### 6.3 测试污染（novel 34，待清理）
- outline：6 幕（3 对重复，R1 证据）。
- chapter 75「终章·余生百年」（R2 垃圾章，含测试正文）。
- 待你确认后清理（恢复 outline 为空 / 删除 ch 75）。novel 34 原有 18 章与 2 条记忆未被改动。

## 七、设计探讨：Agent 如何对已有小说处理 & 全本版本管理

### 7.1 当前 Agent 对已有小说的真实行为（实测）
| 工具 | 行为 | 风险 |
| --- | --- | --- |
| create_novel | 永远新建小说，不接管已有 | 无"继续写某部"入口（靠前端传 novel_id） |
| create_chapter | 按 novel_id+title 新建，标题无唯一约束 | 重复"加一章"会建重名章 |
| write_chapter | 按 chapter_id 全量替换 content（覆盖） | **整章覆盖**：用户 3000 字被 200 字生成覆盖 |
| save_memory | 按 name 合并（幂等） | 安全 ✅ |
| save_outline | 按精确标题合并 | R1：措辞不同→重复幕 |
| list_novels | 只读 | 安全 ✅ |

### 7.2 核心风险（即"Agent 覆盖已有小说"）
1. **覆盖**：`write_chapter` 是整章替换；用户说"扩写/续写"也被当成"重写"。
2. **误造**：R2——引用失败时静默新建章节，数据被悄悄污染。
3. **重复**：R1——大纲措辞不同即翻倍。

### 7.3 全本版本管理方案（应对覆盖，复用现有 version_history 基建）
项目已有 `version_history`（config 启用，`/chapters/:id/versions` 支持 List/Create/Restore）——**逐章版本历史已具备（E1 部分落地）**。缺的是"整本"与"Agent 写前自动快照"。建议分层：
1. **写前自动快照（最优先、最低风险）**：`executeTool` 在 `write_chapter`/`save_outline` 落库前自动打点版本快照（标签 `agent-auto`）。任何覆盖可一键还原。直接复用现有 version_history 表与接口。
2. **整本里程碑快照**：新增 `novel_versions` 概念——时间点捕获全本（所有章节 + 大纲 + 记忆）为一个 bundle，支持整本还原。触发：Agent 会话改某小说前自动打点 + 手动"存里程碑"。
3. **write_chapter 增加 mode**：`replace`（默认）/`append`/`merge`。Agent 在"扩写/续写"时用 `append`，从根上避免整章覆盖。
4. **章节定位工具**：Agent 工具集新增 `list_chapters(novel_id)` / `get_chapter_by_title`，消除 R2 的"编号臆测成标题"。
5. **误造护栏**：`write_chapter` 缺有效 `chapter_id` 时不自动建章，返回错误请用户指定；`create_chapter` 对重名标题警告/拒绝。
6. **变更预览**：Agent 重大改写返回 diff/摘要，UI 侧"确认/撤销"。

### 7.4 与 R1/R2 修复的关系
- R1 修复（`outlineTitleKey` 去"第X幕"等前缀）并入"写前快照 + merge 优化"。
- R2 修复依赖 7.3.4（定位工具）+ 7.3.5（误造护栏）。
- 版本管理（7.3.1/7.3.2）是**兜底**：即便 Agent 仍偶发误造/覆盖，用户也能还原，不再有"白写/被覆盖"的损失焦虑。

### 7.5 待拍板（Q1–Q5）
- **Q1**：是否先做"写前快照"（立即兜底、零破坏）再上 R1/R2 修复？
- **Q2**：`write_chapter` 默认 `replace` 还是 `append`？（影响所有 Agent 写章语义）
- **Q3**：是否需要"整本里程碑快照"，还是仅靠逐章版本足够？
- **Q4**：R1/R2 是否现在就修，还是并入版本管理一起做？
- **Q5**：是否把 `list_chapters`/`get_chapter_by_title` 加入 Agent 工具集？

## 八、实施进度（Phase 1：写前自动快照已落地）

- **2026-09-01**：用户拍板"按推荐开始"。Phase 1 = Agent 写前自动快照（对应 Q1），已实施并部署。
  - **章节**：`ChapterService.SnapshotForAgent`（复用 `chapter_versions`，标签 `agent-auto`，按 contentHash 去重、无 5 分钟节流、best-effort 不阻断写入）；`AgentService.writeChapter` 首行调用。
  - **大纲**：新表 `outline_versions`（`model.OutlineVersion` + `OutlineVersionRepository`），经 AutoMigrate 双模式（PG+SQLite）建表；`NovelDocService.SnapshotOutline` 在 `syncOutline` 写前调用（best-effort，保留最新 50 条）。
  - **提交**：`44e0444`（实现）+ `ec353385`（断言测试，证明章节/大纲两种快照均真实落库）。
  - **验证**：fresh-eyes 代码评审 APPROVED；`go build` / `go vet` / `go test ./internal/service/...` 全绿；新 build 已部署 `:8080` 单实例（NATS 单实例约束），登录 200，前端会话正常，`outline_versions` 自动迁移成功。
  - **novel 34 测试污染已清理**：outline 重置为空、删除 R2 垃圾章 ch75（原 18 章/2 记忆未动）。
- **Phase 2（待启动）**：R1 大纲去重修复 + R2 误造护栏 + Q5 章节定位工具（`list_chapters`/`get_chapter_by_title`）+ Q3 整本里程碑快照（`novel_versions` bundle）。
