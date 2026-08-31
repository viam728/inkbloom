# 施工简报：Agent 创作工作流（从"玩具"到"全本创作流水线"）

> 日期：2026-08-31
> 背景：用户指出当前 Agent 系统偏"玩具"——`agents/team` 是一套为**写代码**设计的
> TaskCard 协作模型（affected_files / code_changes / 验收标准），与小说创作领域完全脱节。
> 目标：让 Agent 能真正接管创作——对话内可选"AI 起稿"，AI 自动执行一条优雅的
> 创作工作流，跑完从零散想法到全本正文的完整链路。

---

## 一、现状诊断

### 1.1 已有点状 AI 能力
- **聊天/续写/改写**：`/api/chat/*`（SSE 流式），有上下文注入，已有。
- **场景生成**：`/api/agents/generate`，scene 白名单 `character / setting / summary / inspiration / outline`，能生成单点内容，但**缺"章节正文"（chapter）**这一最关键场景。
- **知识/伏笔**：`/api/knowledge/*`（实体提取、一致性检查、伏笔探测/回收）+ `foreshadow` 模型。

### 1.2 核心缺陷
1. **场景不全**：没有"章节正文生成"场景，AI 无法直接产出可落库的成稿章节。
2. **编排领域错位**：`agents/team`（Primary/Fullstack/Assistant + 路由 + 重试 + 校验）是为软件工程设计的，`TaskCard` 字段（affected_files/code_changes/tests）与小说无关。用户感知为"玩具"。
3. **无状态机**：没有"从想法→大纲→分章→逐章成稿→伏笔→校验→落库"的**创作级流水线**，AI 只能单点生成，无法连贯跑完一本。
4. **落库断层**：AI 生成的正文与真实章节表（`chapters`）之间没有一条受控的写入路径（作者一键采纳/逐章写入）。

---

## 二、目标：优雅的创作工作流

目标是把 AI 从"文字生成器"升级为"**可接管的创作流水线**"。设计一条领域化状态机，分四层：

```
发起层(对话内"AI起稿"按钮)
   └→ 流水线层(story_pipeline 状态机)
        └→ 场景层(scene registry：chapter/outline/character/setting/summary/inspiration)
             └→ 落库层(Go 端受控写入：chapters/outline/伏笔)
```

### 2.1 流水线状态机 `story_pipeline`（核心新增）
一条 `StoryJob`（创作任务）按阶段推进，每个阶段产出可预览、可最终确认的中间物：

```
[idea] 一句话创意
  → [outline] 展开完整大纲(幕/节点)
  → [plan_chapters] 按大纲节点规划章节清单(标题+一句话梗概)
  → [draft_chapter] 逐章精写成稿(按大纲/前文/记忆/伏笔)
  → [verify] 一致性校验 + 伏笔埋设/回收
  → [finalize] 生成完成态(可整体或逐章落入 DB)
```

关键设计：
- **可中断/可续跑**：每阶段产物存 JSONB（`story_job` 表），状态推进持久化，断电/失败可恢复。
- **可预览/可确认**：作者对每章可选择"采纳"或"重跑"，AI 逐章产出、逐章认可，避免一次性覆盖。
- **幂等**：同一 `job` 重复推进不产生重复章节（按 plan 的 chapter_key 去重）。
- **预算受控**：每阶段 token 用量汇总，经现有 `token_service` 计费。

### 2.2 场景层扩展
新增 `chapter` 场景（正文成稿），并保持现有 scene 兼容。`chapter` 场景的 context 需额外携带：
- 目标节点（本幕/本节点要求）
- 前文精华（已生成章节的标题+摘要，而非全文，控制 token）
- 伏笔待埋/待回收线索
- 人物/设定记忆（复用现有 `memory_items`）

### 2.3 落库层（Go 端）
新增受控写入接口：
- `POST /api/v1/ai/story/jobs` —— 创建全本创作任务（发起）
- `GET /api/v1/ai/story/jobs/:id` —— 查询推进状态/阶段产物
- `POST /api/v1/ai/story/jobs/:id/chapters/:chapterKey/preview` —— 单章预览生成
- `POST /api/v1/ai/story/jobs/:id/chapters/:chapterKey/adopt` —— 采纳该章落库（写 `chapters`）
- `POST /api/v1/ai/story/jobs/:id/finalize` —— 全本批量落库（可选）

---

## 三、为什么这样设计（取舍）

1. **领域化而非通用 Agent 编排**：把 `team` 那套通用 TaskCard 弃用，改用 `story_pipeline` 创作状态机。创作不是"分解成代码任务"，而是"按剧情阶段推进+受控落库"，领域语义远优于通用编排。
2. **状态机而非一次长调用**：全本创作 token 量极大，一次长调用易超时/断流/失败全丢。分阶段+可续跑+可确认，符合"长创作"的真实使用节奏。
3. **受控落库而非 AI 直写**：AI 产物先进 `story_job` 中间产物表，由作者逐章/批量采纳才写真实 `chapters`。避免 AI 错误内容污染正式稿，也保留作者主导权（商业上更重要）。
4. **复用现有能力**：场景注册、上下文组装（`agent_context.go`）、token 计费、知识一致性检查、伏笔提取全部复用，不重复造轮子。

---

## 四、落地路径（分阶段）

1. **P1 状态机 + chapter 场景**（本轮）：ai-service 新增 `story_pipeline` 模块 + `chapter` 场景；Go 端 `story_job` 表 + 组装/预览接口。先打通"想法→大纲→章节规划→成稿"最小闭环。
2. **P2 落库闭环**：采纳单章落库 + 全本批量落库 + 伏笔/记忆回填。
3. **P3 前端入口**：对话内"AI 起稿"按钮 + 工作流进度面板（阶段进度条、逐章预览/采纳）。
4. **P4 体验打磨**：一致性校验报告在面板可视化、重跑单章、断点续跑。

> 本简报为方向性设计，施工随进度更新《核心施工记录》。
