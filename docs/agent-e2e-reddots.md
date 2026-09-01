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
| handler 路由注释 | ⚠️ **红点 R3**：注释写错路径（文档级） |
| reasoning_content 多 tool_call 回传 | ⚠️ **红点 R4**：单响应多 tool_call 时 reasoning 被重复挂载（潜在） |

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

### 🟡 R4 — reasoning_content 在单响应多 tool_call 时被重复挂载（低/潜在）
- **现象**：`internal/service/agent_service.go:189-211`，当一次 LLM 响应含 N 个 tool_calls 且 `resp.ReasoningContent != ""` 时，循环为每个 tool_call 各生成一条 assistant 消息，每条都带同一份 `reasoning_content`。
- **证据**：代码审查。`Run` 在 189 行 `for _, tc := range resp.ToolCalls`，209 行在循环内把 `reasoning_content` 挂到每条 assistant 消息。
- **影响**：冗余 token；个别模型对"多条 assistant tool-call 消息各带相同 reasoning"可能容忍也可能报错（DeepSeek 在用例 1 中正常）。
- **建议修复**：`reasoning_content` 仅挂到第一条 assistant 消息，或改为 OpenAI 标准写法（一条 assistant 消息包含所有 tool_calls + 一次 tool 结果回传）。

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
