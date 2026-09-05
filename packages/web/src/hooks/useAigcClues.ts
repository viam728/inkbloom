import { useEffect, useState } from 'react';
import { fetchOutline } from '@/services/outline-client';
import { fetchMemory } from '@/services/memory-client';
import { listForeshadows } from '@/services/foreshadow-client';
import { useNovelStore } from '@/stores/novel-store';
import { useOutlineStore, type OutlineAct } from '@/stores/outline-store';
import { architectureText, useArchitectureStore } from '@/stores/architecture-store';
import { buildAccessEvalContext, evaluateAccess } from '@/utils/memory-access';

/**
 * AIGC 可选上下文注入的线索摘录加载（备忘录 L61）：
 *
 *  - 架构：architecture-store（左侧板「架构」栏目，localStorage 预制）；
 *  - 大纲 / 记忆 / 悬念：与全本创作线索库同源（fetchOutline / fetchMemory /
 *    listForeshadows），记忆按 AI 访问闸门（六模式）镜像求值过滤——与
 *    useChapterDraft 同谓词（utils/memory-access），位置型硬闸 fail-closed；
 *  - 本章正文 / 附近章节：从 novel-store 现取（每次确认实时计算，不缓存）。
 *
 * 服务端（scene 工作流）对大纲/记忆/悬念走 AgentContextFlags 开关自行装配
 * （门控在服务端求值）；客户端摘录仅用于架构/本章/附近拼接与宿主管线（全本创作）。
 */

export interface AigcClueExcerpts {
  architecture: string;
  outline: string;
  memory: string;
  foreshadow: string;
}

const EMPTY: AigcClueExcerpts = { architecture: '', outline: '', memory: '', foreshadow: '' };

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 模块级缓存：novelId → 摘录（TTL 内复用，避免每张卡重复拉库） */
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { excerpts: AigcClueExcerpts; fetchedAt: number }>();
let inflight: Promise<AigcClueExcerpts> | null = null;
let inflightNovelId = 0;

async function fetchClues(novelId: number): Promise<AigcClueExcerpts> {
  const [outlineR, memoryR, foresR] = await Promise.allSettled([
    fetchOutline(novelId),
    fetchMemory(novelId),
    listForeshadows(novelId),
  ]);

  // 架构（本地预制，同步取；当前作品时用流派预填基本信息）
  const cur = useNovelStore.getState().currentNovel;
  useArchitectureStore.getState().ensure(novelId, cur?.id === novelId ? cur.genre : undefined);
  const architecture = architectureText(novelId);

  const outline =
    outlineR.status === 'fulfilled'
      ? cap(
          outlineR.value
            .map((act) => {
              const nodes = act.nodes
                .map((n) => `${n.title}${stripTags(n.summary) ? `（${stripTags(n.summary)}）` : ''}`)
                .filter(Boolean)
                .join('；');
              return nodes ? `${act.title}：${nodes}` : act.title;
            })
            .filter(Boolean)
            .join('；'),
          1200,
        )
      : '';

  // 记忆：AI 访问闸门（六模式）镜像求值（与 useChapterDraft / 全本创作同规则）：
  // 位置型硬闸 fail-closed 不进摘录；软闸条目照常提供。大纲未加载时按无位置
  // 求值（buildAccessEvalContext([]) 同样 fail-closed，宁可少带不可剧透）。
  const acts: OutlineAct[] = useOutlineStore.getState().byNovel[novelId] ?? [];
  const accessCtx = buildAccessEvalContext(acts);
  const memory =
    memoryR.status === 'fulfilled'
      ? cap(
          memoryR.value.items
            .filter(
              (it) =>
                evaluateAccess(it, accessCtx).inject && (it.name || it.content),
            )
            .map((it) => `${it.name ? `${it.name}：` : ''}${stripTags(it.content)}`)
            .filter(Boolean)
            .join('；'),
          1200,
        )
      : '';

  const foreshadow =
    foresR.status === 'fulfilled'
      ? cap(
          foresR.value
            .filter((f) => f.status === 'planted' || f.status === 'reminded')
            .map((f) => f.description)
            .join('；'),
          800,
        )
      : '';

  return { architecture, outline, memory, foreshadow };
}

/** 拉取（带缓存）指定作品的四类线索摘录；novelId 缺省返回空摘录 */
export async function loadAigcClues(novelId?: number): Promise<AigcClueExcerpts> {
  if (!novelId) return EMPTY;
  const hit = cache.get(novelId);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.excerpts;
  if (inflight && inflightNovelId === novelId) {
    await inflight;
    return cache.get(novelId)?.excerpts ?? EMPTY;
  }
  inflightNovelId = novelId;
  inflight = fetchClues(novelId)
    .then((excerpts) => {
      cache.set(novelId, { excerpts, fetchedAt: Date.now() });
      return excerpts;
    })
    .finally(() => {
      inflight = null;
      inflightNovelId = 0;
    });
  await inflight;
  return cache.get(novelId)?.excerpts ?? EMPTY;
}

/** React 侧：挂载/切换作品时加载，返回摘录（未就绪为 null） */
export function useAigcClues(novelId?: number): AigcClueExcerpts | null {
  const [excerpts, setExcerpts] = useState<AigcClueExcerpts | null>(null);

  useEffect(() => {
    if (!novelId) {
      setExcerpts(null);
      return;
    }
    const hit = cache.get(novelId);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      setExcerpts(hit.excerpts);
      return;
    }
    let alive = true;
    void loadAigcClues(novelId).then((e) => {
      if (alive) setExcerpts(e);
    });
    return () => {
      alive = false;
    };
  }, [novelId]);

  return excerpts;
}

/** 本章正文摘录（当前章节 HTML 转纯文本，cap 1200） */
export function currentChapterExcerpt(): string {
  const ch = useNovelStore.getState().currentChapter;
  if (!ch?.content) return '';
  return cap(stripTags(ch.content), 1200);
}

/** 附近章节摘录（大纲序相邻章：上一章 + 下一章，各 cap 400） */
export function nearbyChaptersExcerpt(): string {
  const { currentChapter, chapters } = useNovelStore.getState();
  if (!currentChapter) return '';
  const idx = chapters.findIndex((c) => c.id === currentChapter.id);
  if (idx < 0) return '';
  const parts: string[] = [];
  const prev = chapters[idx - 1];
  const next = chapters[idx + 1];
  if (prev?.content) parts.push(`上一章《${prev.title}》：${cap(stripTags(prev.content), 400)}`);
  if (next?.content) parts.push(`下一章《${next.title}》：${cap(stripTags(next.content), 400)}`);
  return parts.join('\n');
}
