# InkBloom — 施工任务书（v3 · 业务增强版）

> 🎯 目标：把《InkBloom-业务增强方案-v3》(E1–E7) 拆解为**可直接派发施工的文件级任务**。每项给出：现状证据（文件:行）→ 施工内容 → 涉及文件 → 验收标准。
>
> 📐 文档定位：**施工任务书**。业务侧"为什么做"见 v3 业务方案，本文只回答"改哪个文件、加什么、怎么验"。
>
> ⏱ 文档时间：2026-08-29｜任务编号：`A` 前缀（A01–A39）
>
> ⚠️ 前置：v3 业务方案的 Q1–Q10 尚未拍板，本文按**方案默认值**编写。标注 🔶 的任务在对应决策点未确认前不得开工。

---

## 目录

1. [§0 施工总则](#0-施工总则)
2. [§1 P0 阶段 · A01–A09](#1-p0-阶段--a01a09)
3. [§2 P1-a · A10–A15](#2-p1-a--a10a15)
4. [§3 P1-b · A16–A23](#3-p1-b--a16a23)
5. [§4 P2 · A24–A31](#4-p2--a24a31)
6. [§5 P3 · A32–A39](#5-p3--a32a39)
7. [§6 埋点体系（贯穿）](#6-埋点体系贯穿)
8. [§7 并行编排与全局验收](#7-并行编排与全局验收)

---

## 0. 施工总则

### 0.1 代码契约（施工前必读）

本节是从现有代码反推出的**强制约定**，违反会导致 PR 被拒。

| 契约                | 内容                                                                                                                                                          | 证据                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **C1 表结构归属**      | 新业务表**只需**在 `internal/model/` 定义 struct 并加入 `database.automigrateModels()`；云端 PG 与本地 SQLite 会自动建表。`migrations/*.sql` **仅用于** PG 方言的结构性变更（索引、部分索引、主键切换、序列对齐） | `database.go:19-47`、`migrate.go:18-31`   |
| **C2 迁移幂等**       | `*.up.sql` 必须写成可重复执行（`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`、条件 DDL）。迁移失败 **阻断启动**                                                        | `migrate.go:26-31`、`database.go:88-90`   |
| **C3 用户隔离**       | 所有 repository 方法必须带 `userID` 参数并挂 `Scopes(scope.ForUser(userID))`。**禁止任何绕过 uid 过滤的查询**（code review 红线）                                                      | `chapter_repo.go:47-59`、`scope/scope.go` |
| **C4 响应包装**       | 统一 `dto.APIResponse{Code, Message, Data}`；HTTP 状态码与 `Code` 一致                                                                                               | `chapter_handler.go:29`                  |
| **C5 路由注册**       | 静态路径段必须注册在通配符 `:id` **之前**                                                                                                                                  | `http.go:422`、`http.go:438`              |
| **C6 可选 handler** | 新增 handler 在 `server.Handlers` 结构体中声明为指针，路由注册处 `if h.X != nil` 包裹                                                                                           | `http.go:21-77`、`http.go:298-457`        |
| **C7 写操作门禁**      | `/api/v1` 下所有写操作自动受 `middleware.RequireWritable` 拦截（订阅过期 402）。读操作不受限                                                                                        | `http.go:295`                            |
| **C8 前端路由**       | **未使用 react-router**。公开路由在 `App.tsx` 的 IIFE 中用 `window.location.pathname.match()` 正则匹配，且必须位于 `status` 判断**之前**                                              | `App.tsx:129-136`                        |
| **C9 前端请求**       | 一律走 `services/api-client.ts`（已注入 Bearer、401 单飞续期、402 引导）。业务错误在拦截器内被 `Promise.reject(new Error(message))`，可直接 toast                                          | `api-client.ts:48-58`                    |
| **C10 AI 端点计费**   | 新建 AI 端点必须挂 `RateLimiter.Scope(middleware.ScopeAI)`，并在 SSE 尾帧返回 `usage`                                                                                     | `http.go:341-361`、`main.py:104-113`      |
| **C11 本地模式**      | 新增能力需同时确认在 local（SQLite + 内存 kv + LocalBus）与 cloud（PG + Redis + NATS）两种模式下可用。涉及异步任务时，local 模式走 `LocalBus` + `engine.SubmitLocal`                            | `main.go:296-300`                        |
| **C12 内容安全**      | 任何对外发布的 UGC 内容（E4/E5）必须在写入前过 `contentsafety.Checker`                                                                                                        | `main.go:286-294`                        |
|                   |                                                                                                                                                             |                                          |

### 0.2 标准改动清单模板

每个新增业务模块的改动都遵循这 7 步，任务书中不再逐项重复：

```
1. internal/model/xxx.go            → 定义 struct（含 UserID 字段 + TableName()）
2. internal/database/database.go    → automigrateModels() 追加 &model.Xxx{}
3. internal/dto/xxx_dto.go          → 请求/响应 DTO（可选，简单场景用 gin.H）
4. internal/repository/xxx_repo.go  → 接口 + GORM 实现（Scopes(scope.ForUser(userID))）
5. internal/service/xxx_service.go  → 业务逻辑
6. internal/handler/xxx_handler.go  → HTTP handler（dto.APIResponse 包装）
7. 双处装配：
   - internal/server/http.go        → Handlers 结构体加字段 + 路由注册（if h.X != nil）
   - cmd/server/main.go             → NewXxxRepository / NewXxxService / NewXxxHandler 实例化
```

### 0.3 通用验收门槛（每个任务均适用）

- `cd packages/server && go build ./... && go test ./...` 全绿
- `cd packages/web && pnpm build && pnpm typecheck` 全绿
- `cd packages/ai-service && python -m pytest`（如涉及）
- 新表在 cloud 与 local 两种模式下均能自动创建
- 涉及 user 隔离的新表：写一条 `user_id=B` 的数据，用 user A 的 token 查询必须为空

---

## 1. P0 阶段 · A01–A09

> **E1 版本历史与时间机器 + T1 增量同步 + T5 冲突副本 UI**  
> 周期：第 1–6 周｜这是全部后续工作的信任地基，且 E4 发布态、E6 协作均依赖它。

---

### A01 · `chapter_versions` 表与模型

**现状证据**：无任何版本表。`model/chapter.go` 无历史字段；`DiffViewer.tsx` 仅服务于 AI 改写即时对比（`DiffViewer.tsx:3-8` 的 `DiffViewerProps` 为 `original`/`modified`/`onAccept`/`onReject`），不留痕、不可回溯。

**施工内容**

1. 新建 `packages/server/internal/model/chapter_version.go`：

```go
type ChapterVersion struct {
    ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID      int64          `gorm:"not null;default:0;index:idx_cver_chapter" json:"user_id"`
    ChapterID   int64          `gorm:"not null;index:idx_cver_chapter" json:"chapter_id"`
    NovelID     int64          `gorm:"not null;index" json:"novel_id"`
    Title       string         `gorm:"type:varchar(255)" json:"title"`
    Content     *string        `gorm:"type:text" json:"content,omitempty"`
    ContentJSON datatypes.JSON `gorm:"type:jsonb;column:content_json" json:"content_json,omitempty"`
    WordCount   int            `gorm:"default:0" json:"word_count"`
    // auto=会话自动快照 / milestone=手动存档 / ai_rewrite=AI改写前存点 /
    // rollback=回滚产生 / import=同步冲突副本
    Kind        string    `gorm:"type:varchar(20);not null;default:'auto'" json:"kind"`
    Label       string    `gorm:"type:varchar(255)" json:"label,omitempty"`
    // 内容 sha256 前 16 位，用于连续自动快照去重
    ContentHash string    `gorm:"type:varchar(16);index:idx_cver_chapter" json:"content_hash"`
    CreatedAt   time.Time `gorm:"autoCreateTime;index:idx_cver_chapter" json:"created_at"`
}
```

1. `database.go:22-46` 的 `automigrateModels()` 追加 `&model.ChapterVersion{}`。
2. 新建 `migrations/022_chapter_versions.up.sql`（仅建 PG 专用索引，表本身由 AutoMigrate 建）：

```sql
-- 022: chapter version history (business plan v3 E1)
-- Table shape is owned by GORM AutoMigrate; this migration only adds the
-- PostgreSQL-specific partial index and the retention helper view.
CREATE INDEX IF NOT EXISTS idx_cver_chapter_time
    ON chapter_versions (chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cver_user_time
    ON chapter_versions (user_id, created_at DESC);
```

1. 建对应的 `.down.sql`（`DROP INDEX IF EXISTS` × 2）。

**涉及文件**

- 新增：`internal/model/chapter_version.go`、`migrations/022_chapter_versions.up.sql`、`.down.sql`
- 修改：`internal/database/database.go`

**验收标准**

- [ ] cloud 模式启动后 `\d chapter_versions` 表与两个索引均存在
- [ ] local 模式启动后 SQLite 中表存在（SQLite 跳过 PG 索引语句）
- [ ] 重复启动不报错（迁移幂等）

---

### A02 · 版本仓储层

**现状证据**：`repository/chapter_repo.go:20-31` 定义了完整的 `ChapterRepository` 接口模式（每个方法首参 `ctx`，次参 `userID`）。

**施工内容**

1. 新建 `internal/repository/chapter_version_repo.go`，接口：

```go
type ChapterVersionRepository interface {
    Create(ctx context.Context, v *model.ChapterVersion) error
    GetByID(ctx context.Context, userID, id int64) (*model.ChapterVersion, error)
    ListByChapter(ctx context.Context, userID, chapterID int64, limit, offset int) ([]model.ChapterVersion, error)
    // LatestHash 返回该章节最近一条版本的 hash 与时间，供自动快照去重/节流判断
    LatestAuto(ctx context.Context, userID, chapterID int64) (*model.ChapterVersion, error)
    // PruneAuto 保留每章节最近 keep 条 auto 版本，其余 auto 删除（milestone 永不清理）
    PruneAuto(ctx context.Context, userID, chapterID int64, keep int) (int64, error)
    // CountSince 统计某章节在 since 之后的版本数（保留策略配额判断）
    CountSince(ctx context.Context, userID int64, since time.Time) (int64, error)
}
```

1. 实现要点：
   - `Create` 强制 `v.UserID = userID`
   - `ListByChapter` 返回**不含** `Content`/`ContentJSON` 的摘要（用 `Select("id, chapter_id, kind, label, word_count, created_at")`），避免列表接口拉爆带宽
   - `GetByID` 才返回完整内容
   - `PruneAuto` 用子查询取每章节 `created_at` 排名 > keep 的 auto 行删除

**涉及文件**

- 新增：`internal/repository/chapter_version_repo.go`

**验收标准**

- [ ] `go test ./internal/repository/ -run ChapterVersion` 通过（含跨用户越权用例：user A 传 user B 的 chapterID 必须返回 nil）
- [ ] `PruneAuto` 在 `keep=3`、存在 10 条 auto 时精确删除 7 条，且 milestone 版本不受影响

---

### A03 · 自动快照注入（后端主链路）

**现状证据**：`ChapterService.UpdateChapter`（`chapter_service.go:172-214`）是所有章节写入的唯一入口，前端 `saveChapter`（`editor-store.ts:40`）与 `EditorArea.tsx` 的 2s 防抖最终都汇聚于此。在 `s.chapterRepo.Update(ctx, userID, chapter)`（第 198 行）**之前**插入快照逻辑即可覆盖全部写入路径，且对前端零侵入。

**施工内容**

1. 改造 `internal/service/chapter_service.go`：
   - `ChapterService` 结构体（第 22-26 行）新增 `versionRepo repository.ChapterVersionRepository`
   - `NewChapterService`（第 29 行）签名追加该参数
   - 在 `UpdateChapter` 中，`req.Content != nil` 分支内、`chapterRepo.Update` 调用**之前**插入：

```
   1. 计算 newHash = sha256(content)[:16]
   2. latest, err := versionRepo.LatestAuto(ctx, userID, id)
   3. sameContent := latest != nil && latest.ContentHash == newHash
      staleEnough := latest == nil || time.Since(latest.CreatedAt) >= autoSnapshotInterval
   4. if !sameContent && staleEnough {
          写一条 ChapterVersion{Kind: "auto", ContentHash: newHash, ...}
          versionRepo.PruneAuto(ctx, userID, id, autoKeepPerChapter)
      }
```

1. 常量与配置项：
   - `autoSnapshotInterval` 默认 **5 分钟**；`autoKeepPerChapter` 默认 **20 条**
   - 在 `internal/config/config.go` 增加 `VersionHistory.AutoIntervalMinutes` / `AutoKeepPerChapter`，默认值 5 / 20（便于后续按订阅档位覆盖，见 A07）
2. 快照写入**失败不得阻断保存**：`zap.L().Warn` 后继续（版本是增强能力，不能拖垮主链路）
3. **保留策略钩子**：`PruneAuto` 的 `keep` 参数与"按订阅分层保留时长"在 A07 打通；P0 阶段先只做条数上限，不做到期删除

**涉及文件**

- 修改：`internal/service/chapter_service.go`、`internal/config/config.go`、`cmd/server/main.go`（第 244 行 `NewChapterService` 调用追加 `versionRepo`）

**验收标准**

- [ ] 连续保存同一章节 10 次（间隔 < 5 分钟）只产生 1 条 auto 版本
- [ ] 间隔 > 5 分钟的两次内容变更产生 2 条版本
- [ ] 内容未变化（hash 相同）即使超时也不产生新版本
- [ ] 停掉 versionRepo 模拟失败后，章节保存仍成功（仅日志 WARN）

---

### A04 · AI 改写前强制存点（前端注入）

**现状证据**：AI 改写落库前有且只有两个接受入口——`DiffViewer.tsx:137`（"接受"按钮 `onClick={onAccept}`）与 `CandidatesPanel.tsx:107`（`onAccept(item)`）。二者最终都会触发编辑器 `setContent` → 自动保存覆盖原文，后端无法区分"AI 改写"与"手动编辑"。

**施工内容**

1. 新建 `packages/web/src/services/history-client.ts`：

```ts
export interface ChapterVersionSummary {
  id: number; chapter_id: number; kind: string;
  label?: string; word_count: number; created_at: string;
}
// 在覆盖正文前打一个存点，返回版本号；失败静默（不阻断改写）
export async function snapshotChapter(
  chapterId: number, kind: 'ai_rewrite' | 'milestone', label?: string
): Promise<number | null>;
export async function listChapterVersions(chapterId: number): Promise<ChapterVersionSummary[]>;
export async function getChapterVersion(id: number): Promise<ChapterVersionDetail>;
export async function restoreChapterVersion(id: number): Promise<ChapterVersionSummary>;
```

1. 在 `DiffViewer.tsx` 的 `onAccept` 与 `CandidatesPanel.tsx` 的 `onAccept` **回调执行前**，先 `await snapshotChapter(chapterId, 'ai_rewrite')`（`await` 是必须的，否则可能先落库后存点）。失败仅 toast 提示"存点失败，本次改写将无法回滚"，**不阻断**改写流程。
2. 两处组件需能拿到 `chapterId`：从 `useEditorStore` 的 `currentChapter` 或 tab-store 的 `activeKey` 取（施工时确认最小侵入方式）。

**涉及文件**

- 新增：`packages/web/src/services/history-client.ts`
- 修改：`packages/web/src/components/editor/DiffViewer.tsx`、`packages/web/src/components/editor/CandidatesPanel.tsx`

**验收标准**

- [ ] 走完一次"右键润色 → 接受改写"，版本列表中出现一条 `kind='ai_rewrite'` 记录，其内容为改写**前**的原文
- [ ] 存点接口 500 时，改写仍能正常完成，仅提示存点失败

---

### A05 · 版本历史 API

**施工内容**

1. 新建 `internal/handler/history_handler.go`，方法：

| 方法               | 路由                                                | 说明                                                              |
| ---------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `ListVersions`   | `GET /api/v1/chapters/:id/versions`               | 摘要列表（不含正文），分页 `?limit=&offset=`                                 |
| `GetVersion`     | `GET /api/v1/chapters/:id/versions/:vid`          | 完整内容（含 `content` / `content_json`）                              |
| `CreateSnapshot` | `POST /api/v1/chapters/:id/versions`              | 手动打点，body `{kind, label}`；`kind` 仅允许 `milestone` / `ai_rewrite` |
| `RestoreVersion` | `POST /api/v1/chapters/:id/versions/:vid/restore` | 回滚：先为当前正文存一条 `kind='rollback'` 版本，再用目标版本覆盖章节并失效缓存               |

1. `RestoreVersion` 实现要点：
   - 必须先写 `rollback` 版本再覆盖（保证回滚本身可再回滚）
   - 覆盖后调用 `s.cache.Delete(ctx, fmt.Sprintf(cache.ChapterContent, userID, id))`（对齐 `chapter_service.go:203`）
   - 覆盖后调用 `chapterRepo.RefreshNovelWordCount`（对齐 `chapter_service.go:208`）
   - 返回新产生的 `rollback` 版本摘要
2. 路由注册：
   - `http.go:21-77` 的 `Handlers` 结构体加 `History *handler.HistoryHandler`
   - 在 `http.go` chapter 区块（第 326-331 行）**之后**注册，注意 C5：静态段 `versions/restore` 必须在通配符 `:vid` **之前**

```go
if h.History != nil {
    api.GET("/chapters/:id/versions", h.History.ListVersions)
    api.POST("/chapters/:id/versions", h.History.CreateSnapshot)
    // 静态段先注册（C5）
    api.POST("/chapters/:id/versions/:vid/restore", h.History.RestoreVersion)
    api.GET("/chapters/:id/versions/:vid", h.History.GetVersion)
}
```

1. `main.go` 装配：第 244 行附近加 `versionRepo := repository.NewChapterVersionRepository(db)`，传入 `NewChapterService`；第 257 行附近加 `historyHandler := handler.NewHistoryHandler(chapterService, historyService)`，加入 `server.Handlers{}`（第 324 行结构体字面量）。

**涉及文件**

- 新增：`internal/handler/history_handler.go`、`internal/service/history_service.go`
- 修改：`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] `GET /chapters/:id/versions` 返回摘要列表且**不含** `content` 字段
- [ ] 回滚后章节正文等于目标版本，且列表中新增一条 `kind='rollback'`（其内容是回滚前的正文）
- [ ] 连续回滚两次可回到最初状态
- [ ] user A 传 user B 的 chapterID 一律 404

---

### A06 · 版本历史 UI

**施工内容**

1. 新建 `components/history/HistoryPanel.tsx`：
   - 章节版本时间线（倒序），按 `kind` 着色：`auto` 灰 / `milestone` 蓝 / `ai_rewrite` 紫 / `rollback` 橙 / `import` 绿
   - 每条支持：查看（弹窗只读预览）、回滚（二次确认）、命名（仅 milestone 可改名）
   - 顶部「手动存档」按钮 → `CreateSnapshot{kind:'milestone', label}`
2. 新建 `components/history/VersionCompare.tsx`：**复用 `DiffViewer`**（`DiffViewer.tsx:3-8` 的 props 已完全适配：传 `original=目标版本内容`、`modified=当前正文`、`onReject=关闭`），仅需把 `onAccept` 换成"回滚到此版本"。
3. 入口：在编辑器 `Toolbar.tsx` 加「历史」按钮，唤起右侧抽屉或模态。
4. 新建 `stores/history-store.ts` 管理版本列表与加载态。

**涉及文件**

- 新增：`components/history/HistoryPanel.tsx`、`components/history/VersionCompare.tsx`、`stores/history-store.ts`
- 修改：`components/editor/Toolbar.tsx`

**验收标准**

- [ ] 打开历史面板可看到 A03/A04 产生的各 kind 版本
- [ ] 选中任意两条之外的单条 → 与当前正文的 diff 正确渲染
- [ ] 回滚操作有二次确认，确认后编辑器内容即时更新
- [ ] `pnpm typecheck` 无错

---

### A07 · 版本保留策略（订阅分层）

**施工内容**

1. 扩展 `internal/service/history_service.go`：新增 `ResolveRetention(ctx, userID) (keepCount int, maxAge time.Duration)`，依据订阅状态返回：

| 档位                    | 条数上限 | 最长期限            |
| --------------------- | ---- | --------------- |
| 免费 / 未订阅              | 20   | 3 天             |
| 订阅有效（trialing/active） | 200  | 90 天            |
| 宽限期 / 休眠期             | 200  | 90 天（只读，不产生新版本） |

1. 读取订阅状态复用 `subscription_service.go` 的现有查询（不要重新实现状态机）。
2. 新增定时任务：在现有订阅到期扫描任务（`subscription_service.go` 的每日凌晨任务）中挂载，每日清理超期 `auto` 版本；**`milestone` / `rollback` 永不清理**。
3. 前端在版本列表顶部展示当前档位与保留时长，超限时提示升级。

**涉及文件**

- 修改：`internal/service/history_service.go`、`internal/service/subscription_service.go`（挂载清理任务）
- 修改：`components/history/HistoryPanel.tsx`

**验收标准**

- [ ] 免费账号 3 天前的 auto 版本被清理，milestone 仍在
- [ ] 订阅账号保留 90 天
- [ ] 清理任务重复执行幂等

---

### A08 · T1-a 增量同步：journal 记录与增量导出

🔶 **依赖 Q8 之外的隐含决策：同步采用 journal 增量而非全量重传**（v3 方案 5 章 T1，建议确认）。

**现状证据**：`sync_service.go` 仅 `Export`/`Import` 两个全量能力（`http.go:448-451`），无 `sync_journal` / `sync_id_map` 表。

**施工内容**

1. 新建 `internal/model/sync_journal.go`：

```go
type SyncJournal struct {
    ID        int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID    int64     `gorm:"not null;index:idx_journal_user_seq" json:"user_id"`
    Seq       int64     `gorm:"not null;autoIncrement;index:idx_journal_user_seq" json:"seq"` // 单调递增
    Entity    string    `gorm:"type:varchar(40);not null" json:"entity"`  // chapter|novel|outline|memory|media_content|...
    EntityID  int64     `gorm:"not null" json:"entity_id"`
    Op        string    `gorm:"type:varchar(10);not null" json:"op"`      // upsert|delete
    UpdatedAt time.Time `gorm:"index" json:"updated_at"`
}
```

1. `database.go` 的 `automigrateModels()` 追加 `&model.SyncJournal{}`。
2. 新建 `internal/service/journal_service.go`：`Append(ctx, userID, entity, entityID, op)`。写入失败仅 WARN，不阻断业务。
3. **注入点**（覆盖全部写路径）：
   - `chapter_service.go`：`CreateChapter` / `UpdateChapter` / `DeleteChapter`
   - `novel_doc_service.go`：outline / memory / rhythm 的 Update
   - `media_service.go`：media_contents / topics 的增删改
   - `novel_service.go`：novel 的增删改
4. 扩展 `SyncService`：`ExportIncremental(ctx, userID, sinceSeq, w)` —— 复用 `sync_export.go` 已有的 `buildNovelBundles` / `buildMediaPayload` / `buildKnowledgePayload`（第 93/146/180 行），但只导出 `sync_journal` 中 `seq > sinceSeq` 涉及的实体；返回新的 checkpoint seq。
5. 路由：`GET /api/v1/sync/export?since=<seq>`（原 `/sync/export` 保持全量语义，`since=0` 或不传时走全量）。

**涉及文件**

- 新增：`internal/model/sync_journal.go`、`internal/service/journal_service.go`、`internal/repository/journal_repo.go`
- 修改：`internal/service/chapter_service.go`、`novel_doc_service.go`、`media_service.go`、`novel_service.go`、`sync_service.go`、`internal/handler/sync_handler.go`、`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] 修改 1 章后 `GET /sync/export?since=<上次seq>` 返回的包中仅含该章，包体积显著小于全量
- [ ] 无变更时返回空变更集且不重复导出
- [ ] 删除操作在 journal 中记为 `op=delete` 并在增量包中体现
- [ ] journal 写入失败不影响正常保存

---

### A09 · T5 冲突副本管理 UI

**现状证据**：v3 方案指出——商业化方案 3.2 设计的"整包文档分叉时败者另存冲突副本"在导入侧已实现计数，但**前端无任何查看入口**，用户看不到自己的冲突数据。

**施工内容**

1. 确认 `sync_import.go` 中冲突副本的落库形态（施工时先读该文件 `Import` 方法，定位冲突副本写入位置），统一为：写入 `chapter_versions`（`kind='import'`）或独立 `conflict_copies` 表（若结构差异大，优先前者以复用 A06 的 UI）。
2. 在 `HistoryPanel.tsx` 中，`kind='import'` 的版本标记为「同步冲突副本」，提供「对比当前」「采纳为正文」「丢弃」三个动作。
3. 导入完成的结果报告（成功/跳过/冲突计数）在前端 toast 中展示，并带「查看冲突」跳转。展示位置为现有的 `components/sync/DataModal.tsx`（「数据与云同步」入口，桌面端菜单亦唤起此弹窗）。

**涉及文件**

- 修改：`internal/service/sync_import.go`、`components/history/HistoryPanel.tsx`、`components/sync/DataModal.tsx`

**验收标准**

- [ ] 构造一次真实冲突（两端同时修改同一整包文档后导入），前端可见冲突副本
- [ ] 「采纳为正文」后冲突消失且正文更新；「丢弃」后副本删除

---

## 2. P1-a · A10–A15

> **E2 伏笔与一致性追踪**（周期：第 5–12 周，与 §3 并行）  
> 这是 InkBloom 相对所有竞品最可能建立的认知壁垒。

---

### A10 · 伏笔数据模型

**施工内容**

1. 新建 `internal/model/foreshadow.go`：

```go
type Foreshadow struct {
    ID            int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID        int64     `gorm:"not null;default:0;index:idx_fs_novel" json:"user_id"`
    NovelID       int64     `gorm:"not null;index:idx_fs_novel" json:"novel_id"`
    // 埋设位置
    PlantChapterID *int64   `json:"plant_chapter_id,omitempty"`
    PlantAnchor    string   `gorm:"type:varchar(500)" json:"plant_anchor"`      // 埋设句原文片段
    Description   string    `gorm:"type:text;not null" json:"description"`
    // 期望回收位置（可空=不限）
    ExpectChapter *int      `json:"expect_chapter,omitempty"`
    // planted | reminded | resolved | abandoned
    Status        string    `gorm:"type:varchar(20);not null;default:'planted';index:idx_fs_novel" json:"status"`
    ResolveChapterID *int64 `json:"resolve_chapter_id,omitempty"`
    Source        string    `gorm:"type:varchar(20);not null;default:'manual'" json:"source"` // manual|ai
    CreatedAt     time.Time `gorm:"autoCreateTime" json:"created_at"`
    UpdatedAt     time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}
```

1. 新建 `internal/model/character_state.go`（角色状态快照，支撑"这个角色此刻不该知道 X"校验）：

```go
type CharacterState struct {
    ID          int64          `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID      int64          `gorm:"not null;default:0;index:idx_cs_novel" json:"user_id"`
    NovelID     int64          `gorm:"not null;index:idx_cs_novel" json:"novel_id"`
    CharacterID int64          `gorm:"not null;index" json:"character_id"`
    ChapterID   int64          `gorm:"not null;index" json:"chapter_id"`
    KnownFacts  datatypes.JSON `gorm:"type:jsonb" json:"known_facts"`   // []string
    Location    string         `gorm:"type:varchar(255)" json:"location"`
    Possessions datatypes.JSON `gorm:"type:jsonb" json:"possessions"`   // []string
    Mood        string         `gorm:"type:varchar(255)" json:"mood"`
    UpdatedAt   time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
}
```

1. `database.go` 的 `automigrateModels()` 追加两者。
2. 新建 `migrations/023_foreshadows.up.sql`：建 PG 专用复合索引 `(novel_id, status)` 与 `(novel_id, character_id, chapter_id)` 的唯一约束（upsert 语义需要）。

**涉及文件**

- 新增：`internal/model/foreshadow.go`、`internal/model/character_state.go`、`migrations/023_foreshadows.up.sql` / `.down.sql`
- 修改：`internal/database/database.go`

**验收标准**

- [ ] 两表在 cloud/local 均自动创建
- [ ] `character_states` 上 `(novel_id, character_id, chapter_id)` 唯一约束生效，重复写入走 upsert 不报错

---

### A11 · ai-service 伏笔抽取模块

**现状证据**：`ai-service/app/knowledge/entity_extractor.py:13-93` 是标准的模块范式——`__init__(provider)` 接收 LLM provider，`extract()` 内构造 prompt、调 `self.provider.chat()`、清洗 markdown 代码块、`json.loads`、校验归一化、异常吞掉返回空列表。**新模块必须完全照抄这个范式**。`main.py:78` 处实例化，`main.py:215-230` 注册端点。

**施工内容**

1. 新建 `app/knowledge/foreshadow_extractor.py`，类 `ForeshadowExtractor`，照抄 `EntityExtractor` 的错误处理骨架，提供两个方法：

```python
async def detect_plants(self, text: str, novel_id: int) -> list[dict]:
    """识别文本中的疑似伏笔埋设点。
    返回 [{"anchor": 原文片段, "description": 描述, "suggest_chapter": 建议回收章节号|None}]
    只识别真正的悬念/未解道具/未回答提问，宁缺毋滥；无则返回 []。
    """

async def detect_resolutions(self, text: str, pending: list[dict]) -> list[dict]:
    """判断本章是否回收了 pending 中的伏笔。
    返回 [{"foreshadow_id": int, "resolved": bool, "evidence": 原文依据}]
    """
```

1. prompt 要求：
   - temperature 取 **0.2**（比 entity 的 0.3 更低，宁缺毋滥，误报比漏报更伤体验）
   - 严格 JSON 数组输出，与 `entity_extractor.py:36-42` 的示例格式写法一致
   - `detect_plants` 的 prompt 必须显式给出反例（"景物描写、角色日常对话不构成伏笔"）
2. `main.py`：第 78 行附近加 `_foreshadow_extractor = ForeshadowExtractor(_llm)`；新增两个端点 `/api/knowledge/foreshadows/detect` 与 `/api/knowledge/foreshadows/resolve`，错误返回 `{"plants": []}` / `{"resolutions": []}` 风格（对齐 `main.py:230`）。

**涉及文件**

- 新增：`packages/ai-service/app/knowledge/foreshadow_extractor.py`
- 修改：`packages/ai-service/app/main.py`

**验收标准**

- [ ] 输入一段含明显悬念的文本，`detect_plants` 返回 ≥1 条且 anchor 能在原文中精确匹配到
- [ ] 输入纯景物描写段落，返回 `[]`（不误报）
- [ ] LLM 返回非法 JSON 时返回 `[]` 且不抛异常
- [ ] `python -m pytest app/knowledge/` 通过

---

### A12 · 伏笔服务与 API（server 侧）

**施工内容**

1. 新建 `internal/service/foreshadow_service.go`，注入 `foreshadowRepo`、`chapterRepo`、`aiServiceURL`：
   - `ListPending(ctx, userID, novelID)` → 按状态与 `expect_chapter` 排序的待回收清单
   - `Create(ctx, userID, req)` → 手工登记
   - `UpdateStatus(ctx, userID, id, status)` → `reminded` / `resolved` / `abandoned`
   - `DetectPlants(ctx, userID, novelID, chapterID)` → 调 ai-service `/api/knowledge/foreshadows/detect`，返回**候选**给前端确认（不自动落库）
   - `ScanChapter(ctx, userID, novelID, chapterID)` → 调 `/foreshadows/resolve`，对命中的伏笔自动置 `resolved` 并记 `resolve_chapter_id`（**自动改状态仅限回收检测**，埋设必须人工确认）
2. 新建 `internal/repository/foreshadow_repo.go`（接口模式照抄 `chapter_repo.go:20-31`）。
3. 新建 `internal/handler/foreshadow_handler.go`，路由：

```go
if h.Foreshadow != nil {
    api.GET("/novels/:id/foreshadows", h.Foreshadow.List)
    api.POST("/novels/:id/foreshadows", h.Foreshadow.Create)
    api.PUT("/foreshadows/:fid", h.Foreshadow.UpdateStatus)
    // 静态段先注册（C5）
    api.POST("/novels/:id/foreshadows/detect", h.Foreshadow.DetectPlants)
    api.POST("/novels/:id/foreshadows/scan", h.Foreshadow.ScanChapter)
}
```

1. `main.go` 装配（对齐第 246 行 `knowledgeService` 的写法）。

**涉及文件**

- 新增：`internal/service/foreshadow_service.go`、`internal/repository/foreshadow_repo.go`、`internal/handler/foreshadow_handler.go`、`internal/dto/foreshadow_dto.go`
- 修改：`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] 手工登记 → 列表可见；改状态 → 列表过滤正确
- [ ] `detect` 只返回候选不落库；`scan` 命中后自动 `resolved` 且带 `resolve_chapter_id`
- [ ] 跨用户访问 404

---

### A13 · 伏笔台账 UI

**施工内容**

1. `stores/ui-store.ts:18` 的 `RightTab` 联合类型追加 `'tracker'`：
   ```ts
   export type RightTab = 'chat' | 'review' | 'aigc' | 'title' | 'gallery' | 'tracker';
   ```
2. `components/panels/RightPanel.tsx:10` 的 `NOVELIST_TABS` 数组追加 `{ id: 'tracker', label: '伏笔', icon: <Anchor /> }`（**不加入** `MEDIA_TABS`，自媒体模式无此需求）。
3. 新建 `components/knowledge/ForeshadowTracker.tsx`：
   - 分组展示：待回收（planted/reminded，按 `expect_chapter` 升序）、已回收（resolved）、已废弃（abandoned）
   - 「埋设章节」与「回收章节」均可点击 → 复用现有的 `inkbloom:locate-text` 事件定位到编辑器（`阶段性实现清单 §2.2.14` 已实现该事件）
   - 「AI 检测本章伏笔」按钮 → `DetectPlants` → 候选列表逐条「登记 / 忽略」
4. 新建 `stores/foreshadow-store.ts`。

**涉及文件**

- 新增：`components/knowledge/ForeshadowTracker.tsx`、`stores/foreshadow-store.ts`
- 修改：`stores/ui-store.ts`、`components/panels/RightPanel.tsx`

**验收标准**

- [ ] 小说模式下右侧出现「伏笔」Tab，自媒体模式下不出现
- [ ] 登记一条伏笔后列表即时刷新
- [ ] 点击埋设章节可跳转并高亮到原文

---

### A14 · 角色状态快照与一致性校验增强

**施工内容**

1. 扩展 `internal/service/foreshadow_service.go`（或新建 `consistency_service.go`）：
   - `UpdateCharacterStates(ctx, userID, novelID, chapterID)`：从章节正文抽取角色状态快照写入 `character_states`（复用现有 `knowledge/extract` 的实体结果，避免重复调 LLM）
   - `CheckChapter(ctx, userID, novelID, chapterID, text)`：把**已有实体 + 角色状态 + 待回收伏笔**一并注入 prompt，调用现有 `ConsistencyChecker`，返回分级问题（error/warning/info）
2. 扩展 `packages/ai-service/app/knowledge/consistency_checker.py`：新增 `check_with_states(text, entities, character_states)` 方法，prompt 中明确加入"角色此刻的已知信息"约束。
3. 前端：在 `KnowledgePanel.tsx` 的 `issues` 展示区（第 22 行 `issues` state）区分问题来源（人设矛盾 / 时序矛盾 / 伏笔未回收），并支持点击定位。

**涉及文件**

- 修改：`packages/ai-service/app/knowledge/consistency_checker.py`、`packages/ai-service/app/main.py`、`internal/service/foreshadow_service.go`（或新增 `consistency_service.go`）、`components/knowledge/KnowledgePanel.tsx`

**验收标准**

- [ ] 构造一段"角色说出了他不可能知道的信息"的文本，校验返回 error 级问题且描述准确
- [ ] 人工抽检 20 条问题，误报率 ≤ 30%
- [ ] 问题卡片可点击定位到编辑器原文

---

### A15 · 写作侧边主动提示条

🔶 **依赖 v3 方案 Q 清单外的一项产品决策：主动提示默认开启还是关闭**。建议**默认开启、可一键关闭且记忆偏好**（方案 §8 风险应对）。

**施工内容**

1. 新建 `components/knowledge/ForeshadowHintBar.tsx`：常驻编辑器顶部细条，仅在有提示时展开。提示优先级：
   1. 本作品存在 `expect_chapter` 已超期且状态仍为 `planted` 的伏笔
   2. 本章检测到人设/时序 error 级问题
   3. 距 `expect_chapter` ≤ 2 章的待回收伏笔
2. 关闭后写入 localStorage（`ui-store` 已有持久化模式可复用），不再打扰。
3. 触发时机：章节内容保存后（`saveChapter` 成功回调）拉取一次提示，`300s` 内不重复请求。

**涉及文件**

- 新增：`components/knowledge/ForeshadowHintBar.tsx`
- 修改：`components/editor/EditorArea.tsx`（挂载提示条）

**验收标准**

- [ ] 构造超期伏笔后，打开章节可见提示条；点击可跳转伏笔台账
- [ ] 关闭后刷新页面不再出现；设置页可重新开启
- [ ] 无提示时不占版面（高度折叠为 0）

---

## 3. P1-b · A16–A23

> **E4 阅读器与一键发布 + T2 会话管理**（周期：第 5–14 周，与 §2 并行）

---

### A16 · 发布态数据模型

**施工内容**

1. 新建四个 model（均含 `UserID`，遵循 C3）：

```go
// PublishedWork —— 作品的发布态（与 novel 一对一）
type PublishedWork struct {
    ID          int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID      int64     `gorm:"not null;index:idx_pw_slug" json:"user_id"`
    NovelID     int64     `gorm:"not null;uniqueIndex" json:"novel_id"`
    Slug        string    `gorm:"type:varchar(120);not null;uniqueIndex" json:"slug"`
    Title       string    `gorm:"type:varchar(255);not null" json:"title"`
    Synopsis    string    `gorm:"type:text" json:"synopsis"`
    CoverURL    string    `gorm:"type:varchar(500)" json:"cover_url"`
    // public | unlisted | private
    Visibility  string    `gorm:"type:varchar(20);not null;default:'public';index" json:"visibility"`
    AIInspired  bool      `gorm:"not null;default:false" json:"ai_inspired"` // 生成式AI标识（合规）
    FollowCount int       `gorm:"not null;default:0" json:"follow_count"`
    CreatedAt   time.Time `gorm:"autoCreateTime" json:"created_at"`
    UpdatedAt   time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// PublishedChapter —— 章节发布快照：正文冗余存储，作者改草稿不影响已发布内容
type PublishedChapter struct {
    ID           int64          `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID       int64          `gorm:"not null;index:idx_pc_work" json:"user_id"`
    WorkID       int64          `gorm:"not null;index:idx_pc_work" json:"work_id"`
    ChapterID    int64          `gorm:"not null;index" json:"chapter_id"`
    VersionID    *int64         `json:"version_id,omitempty"`   // 关联 chapter_versions，可溯源
    Title        string         `gorm:"type:varchar(255);not null" json:"title"`
    Content      *string        `gorm:"type:text" json:"content,omitempty"`
    ContentJSON  datatypes.JSON `gorm:"type:jsonb;column:content_json" json:"content_json,omitempty"`
    WordCount    int            `gorm:"not null;default:0" json:"word_count"`
    Position     int            `gorm:"not null;index:idx_pc_work" json:"position"`
    // 定时发布：NULL=立即，否则到点才可见
    ScheduledAt  *time.Time     `gorm:"index" json:"scheduled_at,omitempty"`
    PublishedAt  time.Time      `gorm:"autoCreateTime" json:"published_at"`
}

// ReadingProgress —— 阅读进度（读者侧，跨设备续读）
type ReadingProgress struct {
    ID        int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID    int64     `gorm:"not null;uniqueIndex:idx_rp_user_work" json:"user_id"`
    WorkID    int64     `gorm:"not null;uniqueIndex:idx_rp_user_work" json:"work_id"`
    ChapterID int64     `gorm:"not null" json:"chapter_id"`
    Position  float64   `gorm:"not null;default:0" json:"position"`  // 0~1 章内滚动比例
    UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// ReaderFollow —— 追更关系
type ReaderFollow struct {
    ID        int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID    int64     `gorm:"not null;uniqueIndex:idx_rf_user_work" json:"user_id"`
    WorkID    int64     `gorm:"not null;uniqueIndex:idx_rf_user_work;index" json:"work_id"`
    Notify    bool      `gorm:"not null;default:true" json:"notify"`
    CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}
```

1. `database.go` 的 `automigrateModels()` 追加四个。
2. 新建 `migrations/024_published.up.sql`：建 PG 专用索引 —— `published_chapters(work_id, position)`、`published_chapters(scheduled_at) WHERE scheduled_at IS NOT NULL`（定时发布扫描）、`published_works(visibility, created_at DESC) WHERE visibility='public'`（发现页）。

**设计说明（施工必读）**：`PublishedChapter` **冗余存储正文**而非实时联表 `chapters`。原因：作者继续改草稿时，已发布内容必须保持不变，这是读者体验的底线。`VersionID` 用于溯源"这一版发布的是哪个历史版本"。

**涉及文件**

- 新增：`internal/model/published.go`（四表合一文件）、`migrations/024_published.up.sql` / `.down.sql`
- 修改：`internal/database/database.go`

**验收标准**

- [ ] 四表在 cloud 与 local 均自动创建
- [ ] `published_works.slug` 唯一约束生效，重复 slug 返回明确错误
- [ ] 定时发布索引存在，扫描查询走索引（`EXPLAIN` 验证）

---

### A17 · 发布服务与 API

**施工内容**

1. 新建 `internal/service/publish_service.go`：
   - `PublishWork(ctx, userID, novelID, req)` → 创建/更新 `PublishedWork`，生成 slug（标题拼音/随机串去重，冲突自动加后缀）
   - `PublishChapter(ctx, userID, workID, chapterID, scheduledAt)` → 先为当前正文存一条 `chapter_versions`（`kind='milestone'`，label 为"发布 v{n}"），再冗余写入 `PublishedChapter` 并回填 `VersionID`
   - `Unpublish` / `UpdateVisibility` / `UpdateScheduled`
   - **发布前强制内容安全校验**（C12）：调 `contentsafety.Checker` 检查标题 + 正文，命中违规拒绝发布并记 `content_violations`
   - `AIInspired` 字段：若该章节曾使用过 AI 能力（`token_ledger` 中有该 user 的 `ai_call` 记录），发布时置 `true`
2. 新建 `internal/handler/publish_handler.go`，路由：

```go
if h.Publish != nil {
    api.POST("/publish/works", h.Publish.CreateWork)
    api.PUT("/publish/works/:wid", h.Publish.UpdateWork)
    api.DELETE("/publish/works/:wid", h.Publish.Unpublish)
    api.GET("/publish/works", h.Publish.ListMyWorks)
    api.POST("/publish/works/:wid/chapters", h.Publish.PublishChapter)
    api.DELETE("/publish/chapters/:pid", h.Publish.UnpublishChapter)
}
```

1. `main.go` 装配，并把 `csChecker`（`main.go:286-294` 已构造）注入 `PublishService`。

**涉及文件**

- 新增：`internal/service/publish_service.go`、`internal/repository/published_repo.go`、`internal/handler/publish_handler.go`、`internal/dto/publish_dto.go`
- 修改：`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] 发布一章后，`PublishedChapter` 有独立正文副本；作者再改草稿，已发布内容**不变**
- [ ] 发布内容含违规词时被拒绝，且 `content_violations` 有新记录
- [ ] slug 冲突时自动生成不重复的新 slug
- [ ] 定时发布：设 `scheduled_at` 为未来时间后，未到点不出现在公开接口

---

### A18 · 公开阅读 API（免登录）

**施工内容**

1. 新建 `internal/handler/reader_handler.go`。**关键：这批接口必须绕过 JWT**。
   - 现有路由分组：`/api/v1/public`（`http.go:214`）是匿名组，但它是为功能开关设计的。**新建 `/api/v1/read` 匿名分组**，在 `api.Use(authMiddleware)` **之前**注册。
   - 实现建议：在 `http.go` 中于 `api := engine.Group("/api/v1")`（第 286 行）**之前**插入：

```go
// 公开阅读接口（E4）：免登录，仅读，必须只读且按 visibility 过滤
reader := engine.Group("/api/v1/read")
if h.RateLimiter != nil {
    reader.Use(h.RateLimiter.Scope(middleware.ScopeAPI))  // 复用未登录限流配额
}
if h.Reader != nil {
    reader.GET("/works/:slug", h.Reader.GetWork)
    reader.GET("/works/:slug/chapters", h.Reader.ListChapters)
    reader.GET("/chapters/:pid", h.Reader.GetChapter)  // 需校验所属 work 的 visibility
}
```

1. `GetChapter` **必须**先查所属 `PublishedWork` 的 `visibility`，`private` 直接 404，`unlisted` 仅当 URL 带正确 slug 时放行。定时未到点的章节同样 404。
2. 阅读进度与追更**需登录**，挂在 `api` 组内：
   - `PUT /api/v1/read/progress`、`GET /api/v1/read/progress`
   - `POST /api/v1/read/follows`、`DELETE /api/v1/read/follows/:wid`

**涉及文件**

- 新增：`internal/handler/reader_handler.go`、`internal/service/reader_service.go`
- 修改：`internal/server/http.go`（**注意注册顺序**）

**验收标准**

- [ ] 无 token 请求 `/api/v1/read/works/<slug>` 返回 200
- [ ] `private` 作品在匿名请求下 404（而非返回空数据，避免探测）
- [ ] 未到点的定时章节匿名与登录态下均 404
- [ ] 未登录访问 `/api/v1/read/follows` 返回 401

---

### A19 · 阅读器前端

**现状证据（关键）**：前端**未使用 react-router**（C8）。公开路由在 `App.tsx:129-136` 的 IIFE 中用 `window.location.pathname.match()` 匹配，且位于 `status` 判断之前。`LegalPage` 就是按这个模式接入的（`App.tsx:130-134`）。

**施工内容**

1. `App.tsx` 在 legal 匹配之后插入：

```tsx
// 公开阅读页（E4）：/read/:slug 与 /read/:slug/:chapterId，免登录
const readMatch = window.location.pathname.match(/^\/read\/([\w-]+)(?:\/(\d+))?/);
if (readMatch) {
  return <ReaderPage slug={readMatch[1]} chapterId={readMatch[2]} />;
}
```

1. 新建 `components/reader/ReaderPage.tsx`（容器）：拉作品信息 + 章节列表，未登录时隐藏"追更/进度"相关交互但允许阅读。
2. 新建 `components/reader/ChapterReader.tsx`（正文渲染）：
   - 渲染 `content_json`（TipTap JSON）为只读 HTML —— 建议复用 TipTap 的 `generateHTML` 或现有 `format` 服务的 HTML 渲染器，避免自造
   - 排版控制：字号（小/中/大）、行距、页宽、主题（纸白/米黄/夜间）、**偏好存 localStorage 并记忆**
3. 新建 `components/reader/ReaderSettings.tsx`、`components/reader/ChapterNav.tsx`（上一章/下一章/目录抽屉）。
4. 阅读进度：滚动停止 1s 后上报 `PUT /read/progress`（登录态才上报，游客静默跳过）。
5. **E5 预留**：`ChapterReader` 的段落必须带稳定的 `data-block-index` 属性，供 A28 的段落级互动定位。

**涉及文件**

- 新增：`components/reader/ReaderPage.tsx`、`ChapterReader.tsx`、`ReaderSettings.tsx`、`ChapterNav.tsx`、`stores/reader-store.ts`
- 修改：`App.tsx`

**验收标准**

- [ ] 未登录访问 `/read/<slug>` 可直接阅读，不跳转登录页
- [ ] 登录后阅读进度跨设备同步（换浏览器登录同一账号，打开同一作品定位一致）
- [ ] 排版偏好刷新后保持
- [ ] 每个段落有 `data-block-index`，且在 DOM 中稳定不变
- [ ] `pnpm build` 通过（注意：新页面不应被打包进主应用 chunk，建议 lazy load）

---

### A20 · 作者侧发布面板

**施工内容**

1. 新建 `components/publish/PublishModal.tsx`：从 `ExportModal` 的入口旁新增「发布到 InkBloom」按钮唤起。
   - 作品级：可见性（公开/链接可见/私密）、简介、封面、slug 预览
   - 章节级：勾选已定稿章节、立即发布 / 定时发布（日期时间选择器）
2. 新建 `components/publish/PublishDashboard.tsx`（作者后台）：已发布作品列表、每章状态（已发布/待发布/草稿有改动）、追更人数、读完率。
3. **「草稿有改动」提示**：对比 `chapters.updated_at` 与 `published_chapters.published_at`，提示作者"本章自发布后有修改，是否更新已发布版本"。

**涉及文件**

- 新增：`components/publish/PublishModal.tsx`、`components/publish/PublishDashboard.tsx`、`services/publish-client.ts`、`stores/publish-store.ts`
- 修改：`components/export/ExportModal.tsx`（新增入口）

**验收标准**

- [ ] 勾选章节 → 发布 → 阅读端可见
- [ ] 定时发布到点后自动可见（后端定时任务扫 `scheduled_at`）
- [ ] 发布后修改草稿，面板提示"有改动"且可选择更新

---

### A21 · 定时发布调度

**施工内容**

1. 在 server 启动处新增 ticker（参考现有订阅到期扫描任务的实现方式），每 **60 秒**扫描 `published_chapters WHERE scheduled_at IS NOT NULL AND scheduled_at <= now() AND published_at IS NULL`，把 `published_at` 置为当前时间（即"到点生效"）。
   - 采用"写入时立即落 `published_chapters` 行但 `published_at` 为空、到点回填"的方案，而非到点才插入，保证 `position` 顺序正确
2. 到点后向追更读者推送：复用现有 WS Hub（`server/websocket.go`）发站内通知；短信/邮件**本阶段不做**。
3. 任务必须防重入：local 模式单进程无碍；cloud 模式建议用现有 `pkg/dlock` 分布式锁（与 AIGC 任务引擎同一套）。

**涉及文件**

- 修改：`internal/service/publish_service.go`（新增 `FlushScheduled`）、`cmd/server/main.go`（挂 ticker）

**验收标准**

- [ ] 设定 1 分钟后的定时发布，60s 内自动可见
- [ ] 多实例并发时同一章节不被重复处理
- [ ] 定时章节在到点前对读者不可见

---

### A22 · T2 会话持久化与设备管理

**现状证据**：refresh token 与短信验证码全部走 kvstore —— `auth_service.go:436`（签发时 `kv.Set(refreshKey)`）、`:299`（登出 `kv.Del`）、`:338/:342/:349`（踢出/全部下线）、`:119/:133/:142`（验证码读写）。**无 `user_sessions` 表**，因此：桌面端重启即掉登录、"3 端在线 + 踢最早活跃"无落点、设备管理页无法列出设备。

**施工内容**

1. 新建 `internal/model/user_session.go`：

```go
type UserSession struct {
    ID            int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID        int64     `gorm:"not null;index:idx_us_user" json:"user_id"`
    JTI           string    `gorm:"type:varchar(64);not null;uniqueIndex" json:"jti"`
    DeviceName    string    `gorm:"type:varchar(120)" json:"device_name"`
    DeviceType    string    `gorm:"type:varchar(20)" json:"device_type"`  // web|desktop|mobile
    IP            string    `gorm:"type:varchar(64)" json:"ip"`
    LastActiveAt  time.Time `gorm:"index:idx_us_user" json:"last_active_at"`
    ExpiresAt     time.Time `gorm:"not null;index" json:"expires_at"`
    CreatedAt     time.Time `gorm:"autoCreateTime" json:"created_at"`
}
```

1. `database.go` 追加 `&model.UserSession{}`。
2. 改造 `auth_service.go`：refresh token 的签发/校验/吊销**改为读写 `user_sessions` 表**，kvstore 仅保留验证码（验证码本身不需要设备维度）。具体改点：
   - 第 436 行：签发时 `kv.Set` → 改为 upsert `user_sessions` 行（记录 UA/IP/设备类型）
   - 第 299 行：登出 `kv.Del` → 删除对应 jti 行
   - 第 338/342/349 行：踢出指定会话 / 全部下线 → 删表行
   - **滑动续期**：每次 refresh 更新 `LastActiveAt` 与 `ExpiresAt`
3. **多端上限 3**：签发新会话前统计该 user 的活跃会话数，≥3 时删除 `LastActiveAt` 最早的行，并通过 WS 向被踢端发 4403 关闭码（对齐商业化方案 6.3）。
4. 新增端点：`GET /api/v1/auth/sessions`（设备列表）、`DELETE /api/v1/auth/sessions/:id`（下线指定）。
5. 注意 **C11**：local 模式无 Redis，`user_sessions` 落 SQLite，行为一致。

**涉及文件**

- 新增：`internal/model/user_session.go`、`internal/repository/user_session_repo.go`
- 修改：`internal/service/auth_service.go`、`internal/handler/auth_handler.go`、`internal/server/http.go`、`internal/database/database.go`、`cmd/server/main.go`

**验收标准**

- [ ] 登录 4 个会话后，最早的会话被踢且收到 4403
- [ ] 设备管理页列出设备名/类型/最后活跃/IP，可单个下线
- [ ] 重启服务后登录态保持（此前 kv 模式下会掉）
- [ ] 桌面端重启后无需重新登录

---

### A23 · 阅读数据回流作者仪表盘

**施工内容**

1. 扩展 `internal/service/reader_service.go`：`GetWorkStats(ctx, userID, workID)` 返回：
   - 追更人数（`reader_follows` 计数）
   - 每章读完率（基于 `reading_progress.position` 分布：到达 ≥0.95 的比例）
   - 跳出章节（`position` 最低且后续章节无进度的章节）
   - 新增追更趋势（按日聚合）
2. 埋点补充（配合 §6）：章节曝光、滚动深度（0/25/50/75/100 四档）。
3. 前端：`PublishDashboard.tsx` 新增「数据」Tab，展示上述指标；章节列表每行显示读完率迷你条。

**涉及文件**

- 修改：`internal/service/reader_service.go`、`components/publish/PublishDashboard.tsx`
- 新增：`components/publish/WorkStatsPanel.tsx`

**验收标准**

- [ ] 用两个账号分别读到 100% 与 30%，仪表盘读完率显示 50%
- [ ] 数据有 60s 缓存，频繁打开仪表盘不会打爆数据库

---

## 4. P2 · A24–A31

> **E3 作品数字孪生与主动式 AI + E5 交互式微创作 + T3 用量聚合**（周期：第 13–24 周）

---

### A24 · 作品状态聚合服务

**施工内容**

1. 新建 `packages/ai-service/app/workstate/` 包：
   - `aggregator.py`：`WorkState` 数据类（角色当前状态、未回收伏笔、近期事件、前情摘要、风格画像）
   - `summarizer.py`：分层摘要 —— 全本摘要（≤800 字）+ 近 3 章细摘要（≤1500 字），按 token 预算动态截断
2. 新建 `internal/service/workstate_service.go`（server 侧）：缓存每一版的 `WorkState`（缓存键 `workstate:{userID}:{novelID}`，章节保存后失效），避免每次 AI 调用重算。
3. 改造 `agent_context.go`（现有 `NewAIContextBuilder`）：把所有 AI 调用的默认上下文从"裸拼章节"升级为"注入 WorkState"。

**涉及文件**

- 新增：`packages/ai-service/app/workstate/aggregator.py`、`summarizer.py`、`internal/service/workstate_service.go`
- 修改：`internal/service/agent_context.go`、`internal/service/ai_context.go`

**验收标准**

- [ ] 同一章连续两次续写，第二次不重新计算 WorkState（缓存命中）
- [ ] 章节保存后缓存失效，下次 AI 调用拿到新状态
- [ ] AI 输出中不再出现"与前文矛盾的角色行为"（人工抽检 20 次）

---

### A25 · 自动前情摘要

**施工内容**

1. 新建 `packages/ai-service/app/workstate/auto_summary.py`：`update_summary(previous_summary, new_chapter_text) -> new_summary`，增量更新而非全量重算。
2. 触发点：章节 `WordCount` 增长且距上次更新 > 5 分钟时，异步生成并写入 `novel_memory` 的「前情摘要」分组（复用现有四分组结构，**不新增存储**）。
3. 前端：记忆面板中自动生成的摘要标记为「AI 自动」，可编辑、可关闭自动生成。

**涉及文件**

- 新增：`packages/ai-service/app/workstate/auto_summary.py`
- 修改：`internal/service/novel_doc_service.go`、`components/memory/MemoryPanel.tsx`

**验收标准**

- [ ] 写完一章后 1 分钟内前情摘要自动更新
- [ ] 手动编辑过的摘要不会被下次自动生成覆盖（除非用户确认）

---

### A26 · 风格画像与个性化去 AI 化

**施工内容**

1. 新建 `packages/ai-service/app/style/profile.py`：从正文提取特征 —— 平均句长、对话占比、叙述视角（第一/三人称）、时态、高频词 Top50、标点习惯、段落长度分布。输出为结构化 JSON「风格卡」。
2. 新建 `style/humanizer.py`：基于本人风格卡的个性化改写（替代现有通用"去 AI 化"规则）。
3. 存储：新建 `style_profiles` 表（`novel_id` 唯一、`features` JSONB、`sample_digest`、`version`、缓存用）。
4. 续写时把风格卡作为**硬约束**注入 prompt（"严格遵循以下文风特征"）。
5. Token 成本：风格卡变更才重算（每章保存后比对 `sample_digest`，不同才调 LLM）。

**涉及文件**

- 新增：`packages/ai-service/app/style/profile.py`、`humanizer.py`、`internal/model/style_profile.go`
- 修改：`internal/database/database.go`、`internal/service/ai_context.go`、`components/ai/AIChatPanel.tsx`（风格开关）

**验收标准**

- [ ] 对同一部作品，风格续写的句长分布与作者原文差异 < 20%
- [ ] 风格卡在连续保存未变更时不重复计算（缓存命中率 > 80%）
- [ ] 用户可一键关闭风格约束

---

### A27 · 主动式 AI 介入（卡壳与偏离检测）

**施工内容**

1. 新建 `internal/service/proactive_service.go`：
   - **卡壳检测**：前端上报"同一段落 5 分钟内无有效输入且光标停留"（纯前端逻辑，不上报正文），后端返回 3 个可能走向
   - **偏离大纲检测**：计算本章正文与绑定大纲节点要点的文本相似度（可用低成本的 n-gram 相似度，不必调 LLM），低于阈值提示
   - **人设崩塌**：复用 A14
2. 前端 `components/ai/ProactiveHint.tsx`：侧边栏轻量提示卡，可关闭、可"不再提示此类"。
3. 所有主动提示必须有**全局开关**（设置页），且默认行为记录在 §6 埋点中以便评估有效性。

**涉及文件**

- 新增：`internal/service/proactive_service.go`、`components/ai/ProactiveHint.tsx`
- 修改：`stores/ui-store.ts`、`components/layout/TopBar.tsx`（设置入口）

**验收标准**

- [ ] 卡壳 5 分钟后提示出现，点"采纳"直接插入正文
- [ ] 全局关闭后所有主动提示不再出现
- [ ] 主动提示的有效接受率 ≥ 30%（上线 2 周后统计）

---

### A28 · 段落级互动数据模型与 API（E5）

**施工内容**

1. 新建 `internal/model/interaction.go`：

```go
type Interaction struct {
    ID          int64     `gorm:"primaryKey;autoIncrement" json:"id"`
    UserID      int64     `gorm:"not null;index:idx_it_chapter" json:"user_id"`   // 发表读者
    ChapterID   int64     `gorm:"not null;index:idx_it_chapter" json:"chapter_id"` // published_chapters.id
    // comment | mood | vote | fill
    Type        string    `gorm:"type:varchar(20);not null;index:idx_it_chapter" json:"type"`
    BlockIndex  int       `gorm:"not null" json:"block_index"`   // 对应 data-block-index
    Anchor      string    `gorm:"type:varchar(500)" json:"anchor"` // 划线原文
    Payload     datatypes.JSON `gorm:"type:jsonb" json:"payload"` // comment=正文 / mood=情绪键 / fill=候选词
    // pending | adopted | hidden
    Status      string    `gorm:"type:varchar(20);not null;default:'pending'" json:"status"`
    LikeCount   int       `gorm:"not null;default:0" json:"like_count"`
    CreatedAt   time.Time `gorm:"autoCreateTime;index:idx_it_chapter" json:"created_at"`
}

type InteractionVote struct {
    ID            int64 `gorm:"primaryKey;autoIncrement" json:"id"`
    InteractionID int64 `gorm:"not null;uniqueIndex:idx_iv_pair" json:"interaction_id"`
    UserID        int64 `gorm:"not null;uniqueIndex:idx_iv_pair" json:"user_id"`
    Value         int   `gorm:"not null;default:1" json:"value"`
}
```

1. `database.go` 追加两表。
2. 新建 `internal/handler/interaction_handler.go`：
   - `POST /api/v1/read/chapters/:pid/interactions`（登录才可用）
   - `GET /api/v1/read/chapters/:pid/interactions`（匿名可读）
   - `POST /api/v1/interactions/:iid/like`（点赞）
   - `POST /api/v1/publish/interactions/:iid/adopt`（**作者专用**：采纳进正文 → 走 A05 的 `CreateSnapshot{kind:'milestone'}` 打点后再改草稿）
3. 内容安全（C12）：`comment` 与 `fill` 类型必须过检。

**涉及文件**

- 新增：`internal/model/interaction.go`、`internal/repository/interaction_repo.go`、`internal/service/interaction_service.go`、`internal/handler/interaction_handler.go`、`internal/dto/interaction_dto.go`
- 修改：`internal/database/database.go`、`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] 匿名可读互动列表，未登录发表返回 401
- [ ] 采纳评论后：草稿正文更新 + 产生一条 `kind='milestone'` 版本（可回滚）
- [ ] 违规评论被拒绝且记入 `content_violations`

---

### A29 · 互动 UI（划线评论 / 情绪点击 / 填空共创）

🔶 **依赖 Q4**：首期只做最小闭环（划线评论），分支投票与剧情分支树后置。

**施工内容**

1. `components/reader/ChapterReader.tsx` 增加选中监听：选中文本后浮出「评论」按钮（对齐现有 `ContextMenu.tsx` 的选中浮层交互模式）。
2. 新建 `components/reader/Interactions.tsx`：
   - 段落右侧常驻轻量入口（hover 显示）：评论数气泡 + 情绪图标组（燃/刀/甜/谜）
   - 点击展开侧栏显示该段互动列表
3. 新建 `components/reader/CommentSidebar.tsx`：评论列表 + 发表框；作者身份时每条评论带「采纳」按钮。
4. 新建 `components/reader/FillBlanks.tsx`（P2 后期）：作者留白语法 `【　　】` 解析为可点击填空位，读者投稿候选词，作者采纳后自动填回正文。
5. 采纳后通过 WS 通知被采纳的读者（"你的建议被作者采纳了"）—— 这是留存的核心机制，不可省略。

**涉及文件**

- 新增：`components/reader/Interactions.tsx`、`CommentSidebar.tsx`、`FillBlanks.tsx`
- 修改：`components/reader/ChapterReader.tsx`

**验收标准**

- [ ] 选中段落可评论，刷新后评论仍在且定位到正确段落
- [ ] 作者采纳后正文更新、产生版本、读者收到通知
- [ ] 非作者账号看不到「采纳」按钮

---

### A30 · T3 用量日聚合

**现状证据**：无 `token_usage_daily` 表。运营后台与用户用量面板若要展示趋势，只能实时扫 `token_ledger`（append-only，数据量大后必然慢）。

**施工内容**

1. 新建 `internal/model/token_usage_daily.go`（`user_id`+`date` 唯一、`text_units`、`image_count`、`image_units`）。
2. 在 Token 结算写流水处（`token_service.go` 的扣减事务）**同事务** upsert 当日聚合行。
3. 或（更解耦）每日凌晨定时任务从 `token_ledger` 聚合前一日数据。二选一，建议**前者**（实时性好且与扣减强一致）。
4. 优化 `GET /api/v1/token/stats`（`http.go:310`）改为读聚合表。
5. 运营后台「数据看板」的 Token 消耗趋势改读聚合表。

**涉及文件**

- 新增：`internal/model/token_usage_daily.go`、`internal/repository/token_usage_repo.go`
- 修改：`internal/service/token_service.go`、`internal/handler/token_handler.go`、`internal/database/database.go`

**验收标准**

- [ ] 每次 AI 调用后当日聚合行即时更新
- [ ] 用量面板在 ledger 有 10 万行时仍在 200ms 内返回

---

### A31 · 章节情绪曲线与作者侧互动汇总

**施工内容**

1. 基于 A29 的 `mood` 类型互动，按 `block_index` 聚合生成「章节情绪曲线」（折线或色带）。
2. 作者侧 `WorkStatsPanel.tsx` 新增「读者反馈」Tab：情绪曲线、被点赞最多的评论 Top10、待处理填空投稿。
3. 互动数据回流 E3：把"读者反馈最好的段落"作为风格画像的正样本（A26）。

**涉及文件**

- 修改：`components/publish/WorkStatsPanel.tsx`、`packages/ai-service/app/style/profile.py`

**验收标准**

- [ ] 有 ≥10 条情绪互动的章节可看到曲线
- [ ] 曲线 block_index 与正文段落一一对应

---

## 5. P3 · A32–A39

> **E6 协作与多端 + E7 商业化升级 + T4 审计**（周期：第 23–32 周）

---

### A32 · 协作数据模型与权限

**施工内容**

1. 新建 `internal/model/collaborator.go`（`novel_id`+`user_id` 唯一、`role`：owner/editor/viewer）与 `work_order.go`（约稿单：`novel_id`、`assignee`、`creator`、`requirement`、`due_at`、`status`）。
2. **扩展 `scope` 包**（`internal/scope/scope.go`）：现有 `ForUser(userID)` 是硬隔离。协作需要"用户可见作品集"语义 —— 新增 `ForUserOrShared(userID)`，允许通过 `collaborators` 授权的跨用户读取。
   - **红线**：`ForUser` 保持不变，所有既有接口语义不受影响；只有显式使用新 scope 的接口才放开
3. 新增端点：`POST /api/v1/novels/:id/collaborators`（邀请）、`GET`、`DELETE`、`PUT/:cid`（改角色）。

**涉及文件**

- 新增：`internal/model/collaborator.go`、`work_order.go`、`internal/repository/collaborator_repo.go`、`internal/handler/collaborator_handler.go`
- 修改：`internal/scope/scope.go`、`internal/database/database.go`、`internal/server/http.go`、`cmd/server/main.go`

**验收标准**

- [ ] editor 角色可编辑章节但不能删除作品、不能邀请新成员
- [ ] viewer 角色只读，写接口返回 403
- [ ] 未被授权的用户访问该作品 404（不是 403，避免探测）
- [ ] 既有单用户功能回归全绿（scope 未污染）

---

### A33 · 章节级签出锁（不做实时协同）

🔶 **依赖 Q6**：明确不做 OT/CRDT 实时协同。

**施工内容**

1. 新建 `chapter_locks` 表（`chapter_id` 唯一、`user_id`、`acquired_at`、`expires_at`）。
2. 编辑章节时前端调 `POST /api/v1/chapters/:id/lock`（心跳续期，TTL 5 分钟），离开时释放。
3. 被他人锁定时，编辑器显示"XX 正在编辑"并以只读模式打开。
4. 锁过期自动释放（防止异常退出导致死锁）。

**涉及文件**

- 新增：`internal/model/chapter_lock.go`、`internal/service/lock_service.go`、`internal/handler/lock_handler.go`、`components/collab/LockBanner.tsx`
- 修改：`components/editor/EditorArea.tsx`

**验收标准**

- [ ] A 锁定后 B 进入只读且看到提示
- [ ] A 关闭页面 5 分钟后锁自动释放，B 可编辑
- [ ] 断网异常退出不产生死锁

---

### A34 · 编辑约稿工作流

**施工内容**

1. `work_orders` 的 CRUD API + 状态机（`pending → submitted → reviewed → accepted`）。
2. 前端 `components/collab/WorkOrderPanel.tsx`：编辑下需求卡（选题/要点/字数/截止）→ 作者交稿（草稿态章节）→ 编辑批注（**复用现有 `ReviewPanel`**）→ 定稿（章节 status 置 published 并触发 A17 发布）。
3. 复用 `chapters.status` 现有字段（已有 `draft` 默认值），扩展为 `draft | submitted | accepted | published`。

**涉及文件**

- 新增：`internal/service/work_order_service.go`、`internal/handler/work_order_handler.go`、`components/collab/WorkOrderPanel.tsx`
- 修改：`internal/dto/chapter_dto.go`（status 枚举扩展）

**验收标准**

- [ ] 完整走通一轮约稿：建单 → 交稿 → 批注 → 定稿
- [ ] 批注可定位到正文（复用现有 `inkbloom:locate-text`）

---

### A35 · 读者端移动端（H5 优先）

**施工内容**

1. A19 的 `ReaderPage` 做移动端适配（响应式断点、触摸友好的翻页手势、底部导航）。
2. 不单独开发原生应用；如需小程序，用现有 H5 加壳（`web-view`）承载。
3. 作者端移动端**仅做只读 + 灵感速记**：速记内容一键归入 `novel_memory` 的「灵感素材」分组。

**涉及文件**

- 修改：`components/reader/*`、新增 `components/memo/QuickCapture.tsx`

**验收标准**

- [ ] iPhone/Android 主流机型下阅读器排版正常、无横向滚动
- [ ] 速记内容在桌面端记忆面板的「灵感素材」中可见

---

### A36 · 三档订阅改造

🔶 **依赖 Q7/Q8**（三档定价与"免费档保留完整创作+发布+阅读"）。

**施工内容**

1. `internal/model/subscription.go` 的 `plan` 字段从单一 `base` 扩展为 `creator` / `pro`。
2. 权益矩阵集中到一处（新建 `internal/service/entitlement.go`），所有权益判断（版本保留时长 A07、协作席位数、AI 高级能力开关）**统一走这里**，禁止散落硬编码。
3. 现有 `subscription_service.go` 的状态机保持不变（trialing/active/grace/dormant 流转逻辑不动），只扩展 plan 维度。
4. 前端 `SubscriptionModal.tsx` 改三档展示。

**涉及文件**

- 新增：`internal/service/entitlement.go`
- 修改：`internal/model/subscription.go`、`internal/service/subscription_service.go`、`internal/service/history_service.go`、`components/billing/SubscriptionModal.tsx`

**验收标准**

- [ ] 免费档仍能发布作品并被阅读（增长引擎必须对所有人生效）
- [ ] 免费档版本历史 3 天后被清理，pro 档不清理
- [ ] 权益判断全部走 `entitlement.go`，grep 不到散落的 plan 硬编码

---

### A37 · T4 运营操作审计

**施工内容**

1. 新建 `internal/model/audit_log.go`（`operator_id`、`object_type`、`object_id`、`action`、`before` JSONB、`after` JSONB、`created_at`）。
2. 新建 `internal/pkg/audit/recorder.go`，提供 `Record(ctx, operatorID, objType, objID, action, before, after)`。
3. **覆盖全部 admin 接口**：`admin_handler.go` 的用户封禁、订阅延期、Token 调整、反馈处理，以及 A36 的手动改 plan。
4. 审计表 append-only：不暴露 UPDATE/DELETE 的 repository 方法（对齐 `token_ledger` 的做法）。

**涉及文件**

- 新增：`internal/model/audit_log.go`、`internal/pkg/audit/recorder.go`、`internal/repository/audit_repo.go`
- 修改：`internal/handler/admin_handler.go`、`internal/database/database.go`

**验收标准**

- [ ] 每次后台操作产生一条审计记录，含操作前后值
- [ ] 审计表无 update/delete 路径（代码审查确认）
- [ ] 运营后台可查询审计流水

---

### A38 · 打赏与模板市场（延后）

🔶 **依赖合规前置**：打赏涉及资金结算，需企业主体 + 支付资质（T6）。建议在真实支付（G10）打通后再启动。

**施工内容（占位，待 G10 完成后细化）**

1. 打赏：作品/章节级打赏订单，复用 `payment_orders` 状态机；作者余额、提现门槛与实名。
2. 模板市场：人设卡/大纲/Prompt 模板的 UGC 上架与购买，复用 Token/支付链路。

**验收标准**：待 G10 后补充。

---

### A39 · 多平台构建（承接 v2 的 G19）

**施工内容**：macOS（需 Apple 开发者证书与公证）、Linux（AppImage/deb）构建与签名；CI 环境准备。  
**阻塞**：证书与 CI 环境，非代码工作量为主。

**涉及文件**：`packages/desktop/electron-builder.yml`、CI 配置

---

## 6. 埋点体系（贯穿）

> **当前代码无任何产品级埋点。** v3 方案附录 B 列出的 7 个指标决定后续所有决策，建议**随 P0 一并启动**（单独小任务，不阻塞主线）。

### A40 · 埋点基础设施

**施工内容**

1. 新建 `internal/model/event.go`（`user_id`、`event`、`props` JSONB、`created_at`、`session_id`）。
2. 新建 `POST /api/v1/events`（批量上报，单批 ≤ 50 条；匿名可读场景下允许无 token 上报，带 `anonymous_id`）。
3. 前端 `services/analytics.ts`：`track(event, props)`，本地队列 + 5s 批量 flush + `beforeunload` 兜底；失败静默重试一次。
4. **必须采集的 7 个指标**（对应 v3 附录 B）：

| 事件                            | 触发点                            | 关键 props                          |
| ----------------------------- | ------------------------------ | --------------------------------- |
| `ai_generated` / `ai_adopted` | AI 输出 / 用户保留（区分"生成后 30s 内未撤销"） | `endpoint`、`model`、`units`、`kept` |
| `publish_work`                | A17 发布成功                       | `work_id`、`visibility`            |
| `publish_chapter`             | A17                            | `chapter_id`、`scheduled`          |
| `reader_session`              | A19 阅读页打开                      | `work_id`、`chapter_id`、`is_login` |
| `interaction_created`         | A28                            | `type`、`chapter_id`               |
| `version_restored`            | A05 回滚                         | `kind`、`age_seconds`              |
| `token_recharged`             | 现有支付成功处                        | `pack_code`、`is_repeat`           |

1. 隐私：埋点**不采集正文内容**，只采集 ID 与统计维度；在隐私政策中补充埋点说明（v2 §9.2 的协议页需同步更新）。

**涉及文件**

- 新增：`internal/model/event.go`、`internal/handler/event_handler.go`、`internal/service/event_service.go`、`packages/web/src/services/analytics.ts`
- 修改：`internal/server/http.go`、`cmd/server/main.go`、`components/legal/LegalPage.tsx`（协议文案）

**验收标准**

- [ ] 每个指标在对应动作发生后 5s 内入库
- [ ] 埋点接口 500 不影响主流程
- [ ] 抓包确认请求体中不含正文内容

---

## 7. 并行编排与全局验收

### 7.1 任务依赖图

```
A01─┬─A02─┬─A03─┬─A05─┬─A06─┐
    │     │     └─A04─┘     ├─A07
    │     └─A08             │
    │              A09──────┘
    └─(A01 的版本表被 A17 复用)

A10─┬─A11─┬─A12─┬─A13─┬─A15
    │     └─A14─┘
    └─(character_states 被 A24 复用)

A16─┬─A17─┬─A18─┬─A19─┬─A20─┬─A23
    │     └─A21─┘     └─(A19 的 data-block-index 被 A29 依赖)
    └─A22（独立，可与任意任务并行）

A24─┬─A25─┬─A26─┬─A27
    └─A28─┬─A29─┬─A31
A30（独立）
A32─┬─A33─┬─A34─┬─A35
A36─┬─A37
A40（贯穿，建议 P0 同期启动）
```

### 7.2 并行编队建议

| 编队            | 任务              | 说明                           |
| ------------- | --------------- | ---------------------------- |
| **甲队（信任基建）**  | A01–A09、A40     | 后端为主，前端少量                    |
| **乙队（AI 深度）** | A10–A15、A24–A27 | ai-service + 前端面板，与甲队无技术耦合   |
| **丙队（增长引擎）**  | A16–A23、A28–A31 | 全新模块，可与甲乙完全并行                |
| **丁队（P3）**    | A32–A39         | 依赖 A01（版本历史）与 A16（发布态），P3 启动 |

**甲队必须先于丁队完成**（A32 协作依赖 A05 的版本历史）。

### 7.3 阶段验收门槛

| 阶段        | 门槛                                                            | 不达标处置                                      |
| --------- | ------------------------------------------------------------- | ------------------------------------------ |
| **P0 出口** | ① 任意历史版本可一键回滚且回滚可再回滚；② 增量同步在弱网下断点续传成功；③ cloud 与 local 双模式冒烟全绿 | 不得启动 P3                                    |
| **P1 出口** | ① 发布渗透率 ≥ 15%（活跃作者中至少发布过 1 章的比例）；② 伏笔检测人工抽检误报率 ≤ 30%          | 发布渗透率不达标 → **暂停 A28–A31**（E5 重玩法不投产），先修 E4 |
| **P2 出口** | ① AI 续写风格盲评优于基线；② 主动提示有效接受率 ≥ 30%；③ 互动率 ≥ 15%                 | —                                          |
| **P3 出口** | ARPU 可测且高于改造前                                                 | —                                          |

### 7.4 全局验收清单（所有阶段通用）

- [ ] `cd packages/server && go build ./... && go vet ./... && go test ./...` 全绿
- [ ] `cd packages/web && pnpm build && pnpm typecheck` 全绿，`pnpm lint` 无新增 error
- [ ] `cd packages/ai-service && python -m pytest` 全绿
- [ ] **双模式冒烟**：cloud（docker-compose 起 PG/Redis/NATS）与 local（Electron 内嵌 SQLite）均走一遍主流程
- [ ] **用户隔离回归**：用 A 账号尝试访问 B 的所有新增资源，一律 404
- [ ] **内容安全**：发布链路（A17/A28）在 checker 开启时能拦截违规内容并入 `content_violations`
- [ ] **限流**：新增接口均已挂限流（C10 的 AI 端点挂 `ScopeAI`）
- [ ] **桌面端离线**：断网后本地创作功能不受影响（C11）
- [ ] **迁移幂等**：从空库连续启动两次服务，无报错
- [ ] 新表全部出现在 `.inkbloom` 导出包中（M5 同步契约不被破坏）

### 7.5 风险登记

| #  | 风险                       | 触发任务    | 应对                                                             |
| -- | ------------------------ | ------- | -------------------------------------------------------------- |
| R1 | 自动快照导致写入量翻倍，SQLite 本地库膨胀 | A03     | `autoKeepPerChapter` 上限 + 内容 hash 去重 + 5 分钟节流；上线前压测 1000 次连续保存 |
| R2 | 阅读端 UGC 合规               | A17、A28 | C12 强制过检 + 举报入口 + `AIInspired` 标识；上线前法务过一遍                     |
| R3 | `scope` 扩展污染既有单用户隔离      | A32     | `ForUser` 保持不变，新 scope 只在显式调用处生效；补充跨用户越权单测                     |
| R4 | E3 的 token 成本失控          | A24、A26 | WorkState 与风格卡均缓存，变更才重算；上线前做长篇（50 章）成本压测                       |
| R5 | 主动提示误报引发反感               | A15、A27 | 默认开启但可关闭且记忆；只做高置信度提示；埋点观测接受率                                   |
| R6 | 定时发布多实例重复处理              | A21     | `pkg/dlock` 分布式锁                                               |
| R7 | 埋点缺失导致后续决策无据             | A40     | P0 同期启动，不后置                                                    |

---

## 附录 A：新增表汇总（按任务）

| 表                    | 任务  | 阶段 |
| -------------------- | --- | -- |
| `chapter_versions`   | A01 | P0 |
| `sync_journal`       | A08 | P0 |
| `foreshadows`        | A10 | P1 |
| `character_states`   | A10 | P1 |
| `published_works`    | A16 | P1 |
| `published_chapters` | A16 | P1 |
| `reading_progress`   | A16 | P1 |
| `reader_follows`     | A16 | P1 |
| `user_sessions`      | A22 | P1 |
| `style_profiles`     | A26 | P2 |
| `interactions`       | A28 | P2 |
| `interaction_votes`  | A28 | P2 |
| `token_usage_daily`  | A30 | P2 |
| `collaborators`      | A32 | P3 |
| `work_orders`        | A32 | P3 |
| `chapter_locks`      | A33 | P3 |
| `audit_logs`         | A37 | P3 |
| `events`             | A40 | 贯穿 |

> 全部表**只需**在 `internal/model/` 定义 + 加入 `automigrateModels()`（C1）；`migrations/*.sql` 仅补 PG 专用索引与约束。

## 附录 B：新增前端组件汇总

| 组件                                           | 任务      | 阶段 |
| -------------------------------------------- | ------- | -- |
| `components/history/HistoryPanel.tsx`        | A06     | P0 |
| `components/history/VersionCompare.tsx`      | A06     | P0 |
| `stores/history-store.ts`                    | A06     | P0 |
| `services/history-client.ts`                 | A04     | P0 |
| `components/knowledge/ForeshadowTracker.tsx` | A13     | P1 |
| `components/knowledge/ForeshadowHintBar.tsx` | A15     | P1 |
| `stores/foreshadow-store.ts`                 | A13     | P1 |
| `components/reader/*`（4 个）                   | A19     | P1 |
| `components/publish/PublishModal.tsx`        | A20     | P1 |
| `components/publish/PublishDashboard.tsx`    | A20     | P1 |
| `components/publish/WorkStatsPanel.tsx`      | A23     | P1 |
| `components/ai/ProactiveHint.tsx`            | A27     | P2 |
| `components/reader/Interactions.tsx` 等（3 个）  | A29     | P2 |
| `components/collab/*`（3 个）                   | A32–A34 | P3 |
| `services/analytics.ts`                      | A40     | 贯穿 |

---

*本任务书所有文件路径、行号、类型定义均基于 2026-08-29 的代码库实际状态核对。 🔶 标记的任务在对应决策点（v3 业务方案 Q1–Q10）拍板前不得开工。施工期间若代码结构发生变化，以实际代码为准并同步更新本文档。*
