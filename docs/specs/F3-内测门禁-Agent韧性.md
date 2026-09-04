# F3 · 内测门禁：AI Agent 韧性

## 目标

清零「Agent 缺陷」P0（假成功 + 模型端点错配），并把成本、超时、容错三件事从「裸奔」拉到「可控」。

## 已核实的关键事实

| 事实 | 影响 |
|---|---|
| `agents/team/agents/{primary,fullstack,assistant}.py` 的 `execute()` 是硬编码桩，`assistant.py:65` 恒返回 `all_passed:True` | 团队/批量执行返回 `success=true`，**用户以为有产物实际什么都没生成**。这比报错更危险 |
| `config.py:15-16` `default_model=glm-4.5-air`，`openai_base_url` 默认 `api.deepseek.com`；`_client_for()` 仅配置了 `glm_api_key` 才路由智谱 | 容器未注入智谱 Key → 默认请求打到 DeepSeek 报 model not found，全链路挂 |
| `utils/token_counter.py` 全仓库**零调用** | 已有工具但没接，接上成本很低 |
| `ai_actions/service.py:93-122` 的 `extract_json()`（围栏正则 + 括号切片 + 类型收窄）是全仓最健壮的解析 | 应全量复用，`foreshadow_extractor.py:102,178` 的裸 `json.loads` 换掉 |
| `main.py:352-389` 已有 `degraded=true` 语义（区分「AI 故障」与「确实没结果」） | 推广到 entity/relation/consistency 三个抽取器即可 |
| `orchestrator.py:75-88` 空内容重试 3 次 + SDK `max_retries=2` + oneshot 回退 | 单场景最坏 18 次上游调用 |
| `main.py:141-144` 流式异常把 `[Error] {exc}` 当正文 chunk 下发 | 与 F2-6 呼应：错误串混入作者正文 |
| `aigc/pollinations.py:84-97`、`dalle.py:97-107` 在 `async def` 内做同步 `write_bytes`/PIL 编解码 | 单张图阻塞事件循环 0.1–1s |
| `grpc_server/ai_servicer.py` 忽略 `ChatRequest.context`，`ChatChunk.usage` 从不填充 | gRPC 链路丢 RAG 上下文 + 计费恒为 0 |

## 决策

1. **桩 Agent 下线而非补全**：不实现真实逻辑（超出内测范围），改为返回 `501 UNIMPLEMENTED`，前端/调用方立即感知。路由保留以便将来接入。
2. **模型端点一致性在启动期校验**：fail-fast，模型前缀 ↔ base_url ↔ key 三者不匹配直接拒绝启动。这比运行时兜底更省事。
3. **超时与重试收敛为一组常量**集中管理，禁止散落硬编码。
4. **不加新依赖**：熔断/限流用 `asyncio` 原生 + 计数器实现，不引 `tenacity`/`circuitbreaker`。

---

## F3-1 桩 Agent 下线（P0）

**改** `app/agents/team/agents/{primary,fullstack,assistant}.py`
- `execute()` 改为 `raise NotImplementedError`（或直接 `return task.update_status(status=TaskStatus.FAILED, result_summary="agent not implemented")`）
- 路由层 `app/agents/team/routes.py` 捕获后返回 **HTTP 501** + `{"detail": "agent <name> not implemented"}`
- 删除 `assistant.py:57` 的 `"all checks passed"` 与 `:64-66` 的 `all_passed: True` 假报告

## F3-2 模型/端点一致性（P0）

**改** `app/config.py` —— 新增 `validate_model_routing()`：按 `default_model` 前缀（`glm-` / `deepseek-` / `gpt-`）确定期望的 base_url 与 key 字段，缺失即抛 `RuntimeError`。
**改** `app/main.py` —— startup 事件内调用；失败则进程退出（fail-fast）。

**改** `app/llm/openai_provider.py:40-44` —— `_client_for()` 对未识别模型前缀显式报错，而非静默回落默认端点。

**改** `app/aigc/dalle.py:31` —— 改用独立的 `image_base_url` 配置（新增字段，默认 `https://api.openai.com/v1`）。

## F3-3 抽取器失败语义（P1）

**改** `app/knowledge/entity_extractor.py:88-93`、`relation_extractor.py:98-103`、`consistency_checker.py:101-106`
- 吞异常返回 `[]` 改为返回 `(result, degraded: bool)`；**异常 → HTTP 503**，不再用 200 包装
- 参照 `main.py:352-389` foreshadow 的既有写法，响应体统一带 `degraded` 字段

**改** `packages/server/internal/service/knowledge_service.go:68` —— 识别 503 / `degraded=true`，向前端标注「AI 分析失败」而非静默写入空图谱。

## F3-4 Token 预算（P1）

**新增** `app/prompt/budget.py`
```python
MAX_PROMPT_TOKENS = 24_000
def fit_context(sections: dict[str, str], limit: int = MAX_PROMPT_TOKENS) -> dict[str, str]
```
按优先级裁剪（system > 当前章节 > 大纲要点 > 知识节点 > 伏笔 > 前文），前文走滑窗（保留最近 N token）。

**改** `app/agents/scenes.py:137-150` `_common_context`、`entity_extractor.py:30-42` —— 拼接前过 `fit_context`，并接入 `utils/token_counter.count_tokens`。

## F3-5 超时与重试收敛（P1）

**新增** `app/llm/timeouts.py`
```python
CHAT_TIMEOUT = 30.0        # 单次非流式
STREAM_FIRST_TOKEN = 15.0  # 流式首包
STREAM_TOTAL = 300.0       # 流式总时长
MAX_ATTEMPTS = 2           # 单场景最多 2 次上游调用（原最坏 18 次）
```

**改** `app/llm/openai_provider.py:28-38` —— `AsyncOpenAI(timeout=..., max_retries=1)`。
**改** `app/agents/orchestrator.py:55-133` —— 整体套 `asyncio.wait_for(..., STREAM_TOTAL)`；删除「空内容重试 3 次」，改为单次重试且重试前降精度（裁剪上下文）。
**改** `app/agents/orchestrator.py:94-131` —— step1 不再原样重发完整 `user_prompt`，改传压缩摘要。
**改** `app/grpc_server/ai_servicer.py` —— 用 `context.time_remaining()` 传递剩余 deadline。

## F3-6 熔断与限流（P1）

**新增** `app/llm/breaker.py` —— 简单计数器熔断：连续失败 N=5 次短路 30s，半开探测；按 provider 维度。

**改** `app/agents/orchestrator.py` —— 调用前过 breaker；被短路时直接返回结构化错误（不静默成功）。

## F3-7 多模型降级（P1）

**改** `app/llm/openai_provider.py` —— 新增 `MODEL_FALLBACKS: dict[str, list[str]]`（如 `glm-4.5-air → [deepseek-chat]`）。
**改** `app/config.py` —— 新增 `fallback_enabled: bool = True`。
调用链：主模型异常（401/429/5xx/超时）→ 依次尝试 fallback 列表 → 全败才报错。响应体回填**实际生效的模型名**。

## F3-8 密钥脱敏与健康检查（P1）

**改** —— 全局替换 `f"[Error] {exc}"` 为 `sanitize_error(exc)`：正则脱敏 `sk-[A-Za-z0-9]{8,}` 等 key 形态，截断到 300 字符。
**改** `app/main.py:141-144` —— 流式异常发独立 `event: error` 帧（与 F2-6 的 `onError` 对齐），正文通道只走正文；末帧仍发 usage。
**改** `app/main.py:158-161` —— `/health` 拆为 `/healthz`（存活，恒 ok）与 `/readyz`（缓存上游 ping 30s，失败返 503）。

## F3-9 其余 P1/P2

| 项 | 改动 |
|---|---|
| `pollinations.py:84-97`、`dalle.py:97-107` 同步 IO 阻塞 | 改 `anyio.to_thread.run_sync` |
| `pollinations.py:120-122`、`dalle.py:132-134` `is_available()` 恒 True | 加健康检查缓存（60s）；httpx 超时降到 30s；失败切备用 provider |
| `foreshadow_extractor.py:102,178` 裸 `json.loads` | 复用 `ai_actions/service.py:93-122` 的 `extract_json()` |
| 全部硬编码 `settings.default_model` | 端到端透传调用方 model；`ai_actions/service.py:50` 给 `LLMResponse` 加 `model` 字段并回填 |
| `pipeline.py:250-256` 校验异常标 DONE | 改标 `FAILED` |
| `pipeline.py:100-101` `max_retries` 名不副实 | 改 `while task.retry_count < max_retries` 循环，每次重试后重新 verify |
| `pipeline.py:117-191` batch 不 verify | 复用单任务的 verify/retry |
| `task_card.py:105-125` 无状态机校验 | 加允许迁移表，非法迁移抛错 |
| `ai_servicer.py` `ChatChunk.usage` 未填充 | 末帧填 usage（对齐 HTTP SSE） |
| `ai_servicer.py:29-33` 忽略 `context` | 注入 system 段 |
| `ai_servicer.py:49,82,...` 统一 INTERNAL | 按异常类型映射 `INVALID_ARGUMENT` / `DEADLINE_EXCEEDED` |
| `main.py:37` gRPC server 无 options | 配 `max_concurrent_rpcs`、`max_receive_message_length=32MB`、加日志拦截器 |
| `routes.py:107-108` 枚举无兜底 | `HTTPException(422)` + 白名单 |
| `prompt/builder.py:11-14` 无版本/每次读盘 | 启动期一次性加载 + 校验模板存在，缺失即报错（不再静默回落内联默认值） |
| 无 trace-id | 加中间件注入/透传 Go 侧 `X-Request-ID` |

---

## 验收（离线可验证）

1. 不配置任何 Key 启动 ai-service → 启动失败并打印「model/endpoint/key mismatch」
2. 调 `/api/agents/team/execute` → 返回 **501**，不再返回 `success=true`
3. 把上游 base_url 指向不可达地址 → 请求在 30s 内失败并返回结构化错误（非超时悬挂）
4. 上游连续返回 5xx → 第 6 次请求被熔断短路（立即失败，不实际发出）
5. 上游返回带前言的 JSON → 伏笔抽取仍能解析成功
6. 构造超长章节（>50k 字符）→ 不报 400，自动裁剪后正常生成
7. `GET /healthz` 恒 200；上游不可达时 `GET /readyz` 返 503
8. 流式异常时响应中出现独立 `event: error` 帧，正文流中**无** `[Error]` 字样
9. 并发 100 次图片生成 → 健康检查只打一次，HTTP 接口未被阻塞
