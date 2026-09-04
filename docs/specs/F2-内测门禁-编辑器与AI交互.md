# F2 · 内测门禁：编辑器数据安全与 AI 交互

## 目标

清零「体验缺陷」P0（4 项静默内容丢失）与高频 P1。核心原则：**任何情况下都不能让用户写的东西无声消失**。

## 已核实的关键事实

| 事实 | 影响 |
|---|---|
| `EditorArea.tsx:341-349` 注释明确「章节 tab 走单实例 TipTap；panel 类 tab 常驻挂载（hidden 切换）保留编辑状态」 | 单实例是有意设计（为保 panel 状态），**不能整体改成多实例**；只对 `kind==='chapter'` 的 TipTapEditor 加 `key` |
| `TipTapEditor.tsx:364-381` 用 `editor.commands.setContent()` 换内容，历史栈不清空 | 加 `key` 强制重挂载是最小改动，无需动 setContent 逻辑 |
| `api-client.ts:86-91` 401 续期失败直接 `setState({status:'guest'})` | 编辑树卸载时未 flush 脏草稿 |
| `tab-store.ts:22` 草稿明确不持久化；`editor-store.ts:40` 同上 | 需要新增 localStorage 兜底层，而非改内存 store 语义 |
| `sse-client.ts:22-32` 失败时 `onChunk('[Error] Request failed (500)')` | 错误串直接进正文，需新增独立 `onError` 通道 |
| `App.tsx:134-155` 只有大纲/分析两个面板包了 ErrorBoundary | 根级缺失 |
| `editor-store.ts:63-73` 保存失败仅 `saveStatus='error'`，无重试 | 停止输入后永不重试 |

## 决策

1. **草稿兜底用 localStorage 而非 IndexedDB**：内测阶段草稿量小（单章节 HTML 通常 < 200KB），localStorage 同步 API 更简单可靠，且 `beforeunload` 同步场景必须用它。按 `inkbloom:draft:{tabKey}` 分键，写入节流 1s。
2. **TipTap 隔离只对章节 tab 加 `key`**：panel 类 tab 保持常驻挂载，不影响既有状态保留设计。
3. **SSE 错误走独立通道**：`onError` 回调 + toast，正文通道只收正文。这是唯一能根治"错误串入正文"的做法。
4. **保存失败重试上限 5 次 + 指数退避**，并在顶部常驻「离线未保存」横幅，直到恢复。

---

## F2-1 章节切换历史栈串台（P0）

**改** `components/editor/EditorArea.tsx:344` —— `<TipTapEditor key={activeTab.key} ... />`
> `activeTab.key` 形如 `chapter-{id}`，切换即重挂载，历史栈自然清空。panel 类 tab 的容器已有 `key={t.key}`，不受影响。

**改** `components/editor/TipTapEditor.tsx:364-381` —— `setContent` 后补 `editor.commands.clearHistory()`（双保险，防将来 key 被误删）。

## F2-2 401 续期失败丢草稿（P0）

**改** `services/api-client.ts:86-91` —— 置 guest 前先 `await flushAllDrafts()`（见 F2-3 导出的函数），再弹 toast「登录已过期，草稿已暂存本地」。

## F2-3 草稿本地兜底 + beforeunload（P0）

**新增** `src/utils/draft-vault.ts`
```ts
export function saveDraft(tabKey: string, html: string): void   // 节流 1s，try/catch 吞 QuotaExceeded
export function loadDraft(tabKey: string): string | null
export function dropDraft(tabKey: string): void                 // 保存成功后调用
export function flushAllDrafts(): void                          // 立即写盘，供 401/卸载/beforeunload
export function hasPendingDrafts(): boolean
```

**改** `stores/editor-store.ts`
- `handleChange` 内除 `setDraft` 外追加 `saveDraft(tabKey, html)`
- 保存成功后 `dropDraft(tabKey)`
- 关闭 tab / 切 tab 时 `flushAllDrafts()` 后再 `dropDraft`

**改** `src/main.tsx` 或 `App.tsx` —— 注册 `beforeunload`：若 `hasPendingDrafts()` 或 `saveStatus==='error'`，则 `e.preventDefault(); e.returnValue = ''`。

## F2-4 保存失败可感知 + 重试（P0）

**改** `stores/editor-store.ts:63-73`
- 失败：`saveStatus='error'` + `toast.error('保存失败，正在重试…')`
- 指数退避重试（1s/2s/4s/8s/16s，上限 5 次），重试成功清 `error` 并 `dropDraft`
- 超过上限：置 `offlineUnsaved=true`，顶部渲染常驻横幅「内容未保存到云端（已暂存本地）」+「立即重试」按钮

## F2-5 全局错误兜底（P1）

**改** `App.tsx:134-155` —— 在 `ToastProvider` 内包裹根 `ErrorBoundary`，fallback 提供「重新加载」按钮。

**改** `main.tsx:10` —— 注册 `window.addEventListener('unhandledrejection')` 与 `window.onerror` → toast + 占位埋点（预留上报接口，暂不接入 Sentry）。

## F2-6 AI 交互反馈（P1）

**改** `services/sse-client.ts`
- 新增 `onError?: (err: Error) => void` 参数；`:22-32` 失败改调 `onError`，**不再 `onChunk` 错误串**
- `streamInline` / `streamRewrite` / `streamChat` 增加 `signal?: AbortSignal`，透传到 `fetch`

**改** `stores/ai-store.ts`
- `:396-398`、`:426-428` 的 `catch {}` 补 `toast.error` + 保留「重试」入口
- inline/rewrite 暴露 `stopStreaming` 时真正 `abortController.abort()`

**改** `components/editor/CandidatesPanel.tsx` 等浮层 —— 增加「停止生成」按钮。

**改** `stores/aigc-store.ts:92-96` —— 轮询 catch 置 `status='failed'` + toast + 重试入口；`:93` 轮询加最大次数（30 次 ≈ 60s）与取消句柄，卸载即停。

**改** `services/agent-chat-client.ts:60` + `stores/ai-store.ts:253-256` —— 非流式 Agent 调用补耗时展示「已用 Ns · 正在撰写正文」（暂不改 SSE，属 F3 范畴的接口改造）。

## F2-7 编辑器性能（P1）

**改** `components/editor/TipTapEditor.tsx`
- `useEditor` 增加 `shouldRerenderOnTransaction: false`
- `:177-219` 的 `onUpdate` 内 `getHTML()` 与字数统计节流 300ms（trailing）
- 字数改用增量：基于 transaction 的 `content.size` 而非两次全文正则

**改** `stores/editor-store.ts:57` —— 自动保存成功后**不再全量 `fetchChapters`**，改为本地更新该章字数。

## F2-8 其余 P1 修复

| 项 | 改动 |
|---|---|
| `AppLayout.tsx:115-134` 快捷键冲突 | 所有分支统一先判 `inEditable`，命中则 return |
| `novel-store.ts:238-250` 章节内容失败静默回退 | 生产分支改为显式 `error` 态 + 阻断编辑，禁止以空内容建 tab |
| `task-store.ts:65-67` `setInterval` 从不 clear | 暴露 `stopWatch()`，组件卸载调用；`watching` 条件修正 |
| `ChapterReader.tsx:265-269` 监听器泄漏 | 清理函数内 `removeEventListener` |
| `common/Toast.tsx:36-42` 无去重无上限 | 相同文案合并计数（×N），最多保留 3 条 |
| `AppLayout.tsx:83-102` / `NovelList.tsx:11` 整体订阅 | 改逐字段 selector 或 `useShallow` |
| `CandidatesPanel.tsx:31-42` 采纳按钮仅 hover 可见 | 改常显 |

## F2-9 响应式（P2→本轮做最小版）

**改** `AppLayout.tsx:188-267` —— 加 `lg:` 断点：窄屏下左右两栏改为抽屉（复用已有 UI store 的面板开关），中间编辑器占满。不追求移动端完美，保证 ≥1024px 与 768–1024px 可用。

---

## 验收（离线可验证）

1. 打开 A 章 → 切到 B 章 → Ctrl+Z：撤销只影响 B 章，A 章内容不变
2. 断网写作 30s → 顶部出现「内容未保存」横幅 → 恢复网络 → 自动重试成功，横幅消失
3. 写作中刷新页面 → 内容仍在（来自 localStorage 兜底）
4. 手动让 `/auth/refresh` 返 401 → 弹出「登录已过期，草稿已暂存本地」，重新登录后草稿可恢复
5. 断网触发 AI 续写 → 正文区域**无** `[Error]` 字样，只出现 toast 与重试入口
6. 万字章节连续输入 60s 无掉帧
7. `pnpm -F web build` 通过，`tsc --noEmit` 无错误
