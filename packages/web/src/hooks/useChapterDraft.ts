import { useCallback, useState } from 'react';
import { useOutlineStore } from '@/stores/outline-store';
import { useMemoryStore, sortMemoryItems } from '@/stores/memory-store';
import { useTaskStore } from '@/stores/task-store';
import { resolveSceneModel } from '@/stores/ai-store';
import { saveOutline } from '@/services/outline-client';
import { agentGenerate } from '@/services/agent-client';
import { buildAccessEvalContext, evaluateAccess } from '@/utils/memory-access';
import { useToast } from '@/components/common/Toast';

/**
 * AI 成章（scene=chapter）共享生成逻辑：节点编辑「扩写成稿」与正文编辑
 * 「AI 成章」复用同一条带完整上下文（大纲结构 / 前文 / 记忆 / 伏笔）的
 * Agent 管线，避免两处实现漂移。写入动作（建章 / 覆盖当前正文）由各自宿主
 * 处理，本 hook 只负责生成与注入设定的收集。
 */
export interface ChapterDraft {
  /** 初稿 HTML；null 表示未生成 / 生成中 */
  draft: string | null;
  /** 注入的作品记忆条目名 */
  memoryRefs: string[];
  /** 正在生成 */
  generating: boolean;
  /** 运行成章；返回初稿 HTML（失败返回 null）。nodeId 缺省则按整本上下文生成；
   *  context 为 AIGC 卡上下文开关（缺省全量注入，大纲/记忆/悬念由服务端装配求值门控） */
  generate: (novelId: number, opts?: {
    nodeId?: string;
    instruction?: string;
    context?: { outline?: boolean; memory?: boolean; foreshadow?: boolean; preceding_chapters?: boolean };
  }) => Promise<string | null>;
  reset: () => void;
}

const DEFAULT_INSTRUCTION =
  '请基于该要点的标题与梗概、它在大纲中的位置、前文与既有设定，撰写本章完整正文。';

export function useChapterDraft(): ChapterDraft {
  const [draft, setDraft] = useState<string | null>(null);
  const [memoryRefs, setMemoryRefs] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const { showToast } = useToast();

  const generate = useCallback<ChapterDraft['generate']>(
    async (novelId, opts) => {
      setGenerating(true);
      setDraft(null);
      setMemoryRefs([]);

      // 右侧栏任务通知（备忘录 L61）：成章是同步调用，包一层本地伪任务，
      // 在任务面板显示进行中 → 已完成/失败，终态后自动销毁。
      const taskId = crypto.randomUUID();
      useTaskStore.getState().register({
        id: taskId,
        type: 'chapter_generate',
        status: 'running',
        progress: 10,
        novel_id: novelId,
        local: true,
      });

      // 收集注入设定：与服务端记忆访问闸门同规则求值（AI访问权限六模式；
      // 软闸 hidden/ignore 条目会带约束指令注入，硬闸位置不符不注入）。
      // 旧章节锁（visible_chapters 任一完成即解锁）已在 normalizeAccess
      // 迁移为 partial_visible，按写作位置求值。
      let refs: string[] = [];
      try {
        const mem = useMemoryStore.getState();
        if (!mem.byNovel[novelId]) await mem.loadMemory(novelId);
        const items = useMemoryStore.getState().byNovel[novelId] ?? [];
        const allActs = useOutlineStore.getState().byNovel[novelId] ?? [];
        const evalCtx = buildAccessEvalContext(allActs);
        refs = sortMemoryItems(items)
          .filter((i) => evaluateAccess(i, evalCtx, opts?.nodeId).inject)
          .map((i) => i.name)
          .slice(0, 6);
      } catch {
        /* 无设定也可成章 */
      }

      try {
        // 先落盘大纲，确保 Agent 从 DB 读到最新节点概要。
        const latestActs = useOutlineStore.getState().byNovel[novelId];
        if (latestActs) await saveOutline(novelId, latestActs).catch(() => {});
        const res = await agentGenerate({
          novel_id: novelId,
          scene: 'chapter',
          node_id: opts?.nodeId,
          instruction: opts?.instruction ?? DEFAULT_INSTRUCTION,
          model: resolveSceneModel('expand'),
          // AIGC 卡上下文开关（缺省 undefined = 服务端全量注入）
          context: opts?.context,
        });
        setMemoryRefs(refs);
        setDraft(res.content);
        useTaskStore.getState().update(taskId, { status: 'success', progress: 100 });
        return res.content;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '请重试';
        showToast(`成章失败：${msg}`, 'error');
        setDraft(null);
        useTaskStore.getState().update(taskId, { status: 'failed', error_msg: msg });
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [showToast],
  );

  const reset = useCallback(() => {
    setDraft(null);
    setMemoryRefs([]);
  }, []);

  return { draft, memoryRefs, generating, generate, reset };
}
