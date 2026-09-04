import { create } from 'zustand';
import apiClient from '@/services/api-client';
import { setLocalContent } from '@/services/local-backend';
import { useNovelStore } from './novel-store';
import { useTabStore, chapterTabKey, type EditorTab } from './tab-store';
import { dropDraft } from '@/utils/draft-vault';
import { toast } from '@/components/common/Toast';

const DEV_MOCK = import.meta.env.DEV;

/** 保存失败重试：指数退避基数与最大次数（F2-4） */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_ATTEMPTS = 5;

interface EditorStore {
  /** 以下四项为当前 active tab 的镜像，由 EditorArea 经 mirrorTab 灌入（供 ReviewPanel 等既有消费者读取） */
  content: string;
  wordCount: number;
  isDirty: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  /** 离线未保存横幅：保存连续失败且重试耗尽后置 true，顶部常驻提醒（F2-4） */
  offlineUnsaved: boolean;
  /** 手动触发重试（横幅按钮 / 保存失败提示） */
  retryFailedSaves: () => void;

  setContent: (content: string) => void;
  setWordCount: (count: number) => void;
  /** 保存章节：content 缺省时回退对应 tab 草稿（再回退镜像值），保存结果回写 tab-store */
  saveChapter: (chapterId: number, content?: string) => Promise<void>;
  /** 以 active tab 同步镜像（tab 为 null 时清空镜像） */
  mirrorTab: (tab: EditorTab | null) => void;
  /** 立即保存所有脏 tab（切换作品等清理场景前置 flush，保存为异步尽力而为） */
  flushDirtyTabs: () => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  content: '',
  wordCount: 0,
  isDirty: false,
  saveStatus: 'idle',
  offlineUnsaved: false,

  retryFailedSaves: () => {
    set({ offlineUnsaved: false });
    get().flushDirtyTabs();
  },

  setContent: (content) => {
    set({ content, isDirty: true });
  },

  setWordCount: (count) => {
    set({ wordCount: count });
  },

  saveChapter: async (chapterId, content) => {
    const tabKey = chapterTabKey(chapterId);
    const tabStore = useTabStore.getState();
    const tab = tabStore.tabs.find((t) => t.key === tabKey);
    if (tab?.saveStatus === 'saving') return;
    // 正文取参顺序：显式入参（调用方 flush 的草稿快照）→ tab 草稿 → 镜像值
    const body = content ?? tab?.draft ?? get().content;
    const isActive = tabStore.activeKey === tabKey;
    tabStore.updateTab(tabKey, { saveStatus: 'saving' });
    if (isActive) set({ saveStatus: 'saving' });
    try {
      await apiClient.put(`/chapters/${chapterId}`, { content: body }) as any;
      dropDraft(tabKey);
      useTabStore.getState().updateTab(tabKey, { isDirty: false, saveStatus: 'saved' });
      if (useTabStore.getState().activeKey === tabKey) {
        set({ saveStatus: 'saved', isDirty: false, offlineUnsaved: false });
      }
      // F2-7：不再全量 fetchChapters（连续写作时每 2s 重拉整份列表）。
      // 字数本地更新到章节列表；列表的权威刷新交给按需路径。
      const wordCount = useTabStore.getState().tabs.find((t) => t.key === tabKey)?.wordCount;
      if (wordCount != null) {
        useNovelStore.getState().updateChapterWordCount(chapterId, wordCount);
      }
      // 通知主动提示条刷新：刚写完，伏笔的超期状态可能刚变化（业务方案 v3 A15）
      window.dispatchEvent(
        new CustomEvent('inkbloom:chapter-saved', { detail: { chapterId } }),
      );
    } catch (e) {
      console.error('saveChapter failed', e);
      if (DEV_MOCK) {
        // 后端不可用：降级本地保存，保持无感
        setLocalContent(chapterId, body);
        dropDraft(tabKey);
        useTabStore.getState().updateTab(tabKey, { isDirty: false, saveStatus: 'saved' });
        if (useTabStore.getState().activeKey === tabKey) set({ saveStatus: 'saved', isDirty: false });
      } else {
        useTabStore.getState().updateTab(tabKey, { saveStatus: 'error' });
        if (useTabStore.getState().activeKey === tabKey) set({ saveStatus: 'error' });
        // F2-4：失败可感知 + 指数退避自动重试；草稿仍在本地兜底层
        toast.show('保存失败，正在自动重试…（内容已暂存本地）', 'error');
        scheduleSaveRetry(chapterId, body);
      }
    }
  },

  mirrorTab: (tab) => {
    if (!tab) {
      set({ content: '', wordCount: 0, isDirty: false, saveStatus: 'idle' });
      return;
    }
    set({
      content: tab.draft,
      wordCount: tab.wordCount,
      isDirty: tab.isDirty,
      saveStatus: tab.saveStatus,
    });
  },

  flushDirtyTabs: () => {
    const { saveChapter } = get();
    for (const t of useTabStore.getState().tabs) {
      if (t.kind === 'chapter' && t.chapterId != null && t.isDirty && t.saveStatus !== 'saving') {
        void saveChapter(t.chapterId, t.draft);
      }
    }
  },
}));

/** 活跃的重试计时器：tabKey → timer（重试成功/新保存启动时清除） */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * F2-4：保存失败后的指数退避重试（1s/2s/4s/8s/16s，上限 5 次）。
 * 重试期间用户继续输入会触发新的正常保存并重置 saveStatus，旧重试
 * 到点后看到 tab 已非 error / 已保存便自动退避。
 */
function scheduleSaveRetry(chapterId: number, content: string): void {
  const tabKey = chapterTabKey(chapterId);
  const prev = retryTimers.get(tabKey);
  if (prev) clearTimeout(prev);

  let attempt = 0;
  const attemptOnce = () => {
    attempt += 1;
    const tab = useTabStore.getState().tabs.find((t) => t.key === tabKey);
    // 已被新保存接管或已保存成功：放弃这轮重试
    if (!tab || tab.saveStatus !== 'error') {
      retryTimers.delete(tabKey);
      return;
    }
    void useEditorStore.getState().saveChapter(chapterId, content).then(() => {
      const after = useTabStore.getState().tabs.find((t) => t.key === tabKey);
      if (after?.saveStatus === 'error' && attempt < RETRY_MAX_ATTEMPTS) {
        retryTimers.set(tabKey, setTimeout(attemptOnce, RETRY_BASE_MS * 2 ** attempt));
      } else if (after?.saveStatus === 'error') {
        // 重试耗尽：常驻横幅接管（F2-4），直到用户手动重试或保存成功
        useEditorStore.setState({ offlineUnsaved: true });
        retryTimers.delete(tabKey);
      }
    });
  };
  retryTimers.set(tabKey, setTimeout(attemptOnce, RETRY_BASE_MS));
}
