# 施工简报：对话式创作 Agent（工具调用闭环）

> 日期：2026-09-01
> 背景：用户纠偏——之前的「AI 起稿」是独立面板 + 命令词预设/页面跳转，不是真正的 Agent。
> 核心诉求：做一个**初步的对话式 Agent**，能理解意图、调用创作工具、把内容真正写回系统。

---

## 一、问题诊断（为什么当前不是 Agent）

1. **Skill ≠ 命令词预设/跳转**：之前 `chat-skills` 的 prompt 类只是把固定文本塞进输入框，navigate 类只是切面板。用户要的是：点 Skill = 触发 Agent 真正执行一个创作动作。
2. **无工具调用闭环**：`AIChatPanel` 只做 `streamChat`（纯 LLM 聊天），LLM 无法调用后端工具，无法创建小说/章节。
3. **内容未写回系统**：全本创作 `AdoptChapter` 写入了 DB，但前端 `novel-store` 未刷新，编辑器侧边栏看不到新章节——"没看到加载进系统"。
4. **任务创建按钮无效**：StoryWorkflowPanel 依赖 `currentNovel`（用户未打开作品时为 null），创建被拦截。

## 二、目标：最小可用对话 Agent

一个「对话 → 工具调用 → 写回系统 → 前端刷新」的闭环：

```
用户消息 → LLM(tools=创作工具集)
  → 返回 tool_call（如 create_novel） → Go 执行工具（真实落库）
  → 结果作为 tool 消息回传 → 再调 LLM
  → 直到 LLM 返回最终自然语言回复 → 前端展示 + 刷新数据
```

**工具集（映射到已有 service，复用不重造）**：
1. `create_novel(title, genre, description)` → NovelService.CreateNovel
2. `create_chapter(novel_id, title)` → ChapterService.CreateChapter（骨架）
3. `write_chapter(novel_id, chapter_id, instruction)` → 用 chapter 场景生成正文并 UpdateChapter
4. `list_novels()` → NovelService.ListNovels

## 三、架构分层

1. **ai-service**：`openai_provider.chat` 加 `tools` 参数（OpenAI 兼容 function calling）；新增 `/api/agent/chat` 端点返回 tool_calls。
2. **Go**：`agent_service.go`（工具注册表 + 执行器 + Agent 循环）+ `agent_handler.go` + 路由 `/api/v1/ai/agent/chat`。
3. **前端**：对话走 agent 端点；Skill 变为「触发 Agent 动作」；工具执行后 dispatch 事件刷新 `novel-store`。

## 四、落地顺序

1. ai-service function calling 支持（provider + 端点）
2. Go Agent 循环（工具注册表 + 执行器）
3. 前端接入 + 刷新联动
4. 修任务创建按钮 + Skill 语义

> 测试按最小调用：用单一工具调用验证闭环，不批量跑 LLM。
