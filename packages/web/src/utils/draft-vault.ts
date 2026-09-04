/**
 * 草稿本地兜底层（F2-3）：`inkbloom:draft:{tabKey}` 分键存 HTML。
 *
 * 为什么必须存在：tab-store 的草稿不 persist（体积大），防抖窗口内刷新 /
 * 关标签页 / 断网保存失败，都会让「最后输入的内容」无声消失。localStorage
 * 同步 API 是 beforeunload 钩子里唯一可靠的落盘手段。
 *
 * 生命周期：
 * - 编辑时 saveDraft（1s 节流，try/catch 吞 QuotaExceeded）
 * - 保存成功后 dropDraft（editor-store.saveChapter）
 * - 401 登出 / beforeunload 前 flushAllDrafts
 * - openTab 时 loadDraft 恢复遗留草稿（vault 有值即视为未保存成功过的证据）
 */

const PREFIX = 'inkbloom:draft:';
const SAVE_THROTTLE_MS = 1000;

/** 正在进行的节流 timer，key → timer id */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** key → 待写 HTML（节流窗口内最新值） */
const pendingPayloads = new Map<string, string>();

const vaultKey = (tabKey: string) => `${PREFIX}${tabKey}`;

/** 立即把某个 key 的待写草稿写入 localStorage（节流 flush 的原语） */
const writeNow = (tabKey: string): void => {
  const payload = pendingPayloads.get(tabKey);
  if (payload === undefined) return;
  pendingPayloads.delete(tabKey);
  try {
    localStorage.setItem(vaultKey(tabKey), payload);
  } catch {
    // QuotaExceeded / 隐私模式：兜底层不可用时静默放弃，主链路不受影响
  }
};

/** 编辑时调用：1s 节流写入 */
export function saveDraft(tabKey: string, html: string): void {
  pendingPayloads.set(tabKey, html);
  if (pendingTimers.has(tabKey)) return;
  pendingTimers.set(
    tabKey,
    setTimeout(() => {
      pendingTimers.delete(tabKey);
      writeNow(tabKey);
    }, SAVE_THROTTLE_MS),
  );
}

/** 保存成功后清除兜底 */
export function dropDraft(tabKey: string): void {
  const timer = pendingTimers.get(tabKey);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(tabKey);
  }
  pendingPayloads.delete(tabKey);
  try {
    localStorage.removeItem(vaultKey(tabKey));
  } catch {
    // ignore
  }
}

/** 读取遗留草稿（无 / 读失败 / 隐私模式返回 null） */
export function loadDraft(tabKey: string): string | null {
  try {
    return localStorage.getItem(vaultKey(tabKey));
  } catch {
    return null;
  }
}

/** 立即把所有待写草稿落盘（401 登出 / beforeunload / 卸载前调用） */
export function flushAllDrafts(): void {
  for (const key of [...pendingTimers.keys()]) {
    const timer = pendingTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(key);
    }
    writeNow(key);
  }
}

/** 是否存在任何内存中待写草稿 */
export function hasPendingDrafts(): boolean {
  return pendingPayloads.size > 0;
}

/** 是否存在任何本地兜底草稿（含已落盘的） */
export function hasAnyDraft(): boolean {
  if (hasPendingDrafts()) return true;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(PREFIX)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}
