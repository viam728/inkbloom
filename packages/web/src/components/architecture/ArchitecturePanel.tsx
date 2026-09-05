import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Plus } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useArchitectureStore,
  ARCH_GROUPS,
  type ArchGroupKey,
  type ArchBasicInfo,
} from '@/stores/architecture-store';

/**
 * 小说架构导航器（左侧板「架构」栏目，架构栏重构后瘦身为导航摘要）：
 * 编辑主战场迁入中央标签页「小说架构」（ArchitectureEditor，Home tab）。
 * 本面板只做三件事：基本信息只读摘要、各组类条目计数与点击跳转、
 * 内联快速添加。点击条目 → 设置焦点并派发 inkbloom:open-architecture
 * 打开/定位中央编辑器。
 */

const inputCls =
  'w-full min-w-0 rounded-md bg-white/5 border border-white/8 px-2 py-1 text-[10px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors';

const BASIC_LABELS: { key: keyof ArchBasicInfo; label: string }[] = [
  { key: 'genre', label: '流派' },
  { key: 'theme', label: '主题' },
  { key: 'tags', label: '标签' },
  { key: 'plannedChapters', label: '规划章节' },
  { key: 'wordsPerChapter', label: '每章字数' },
  { key: 'channel', label: '发布渠道' },
];

/** 打开中央架构编辑器（可选定位到某条目） */
const openArchitecture = (focus?: { group: ArchGroupKey; id: string }) => {
  if (focus) useArchitectureStore.getState().setFocus(focus);
  window.dispatchEvent(new CustomEvent('inkbloom:open-architecture'));
};

const ArchitecturePanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const novelId = currentNovel?.id;
  const ensure = useArchitectureStore((s) => s.ensure);
  const addEntry = useArchitectureStore((s) => s.addEntry);
  const arch = useArchitectureStore((s) => (novelId ? s.byNovel[novelId] : undefined));

  // 切换作品即初始化（流派预填基本信息）
  useEffect(() => {
    if (novelId) ensure(novelId, currentNovel?.genre);
  }, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [openGroups, setOpenGroups] = useState<Set<ArchGroupKey>>(new Set(['coreClues']));
  const [newTitles, setNewTitles] = useState<Partial<Record<ArchGroupKey, string>>>({});

  if (!novelId) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
        选择作品后管理小说架构
      </div>
    );
  }

  const basic = arch?.basic;
  const basicFilled = !!basic && BASIC_LABELS.some((f) => basic[f.key]?.trim());

  const toggleGroup = (key: ArchGroupKey) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleAdd = (group: ArchGroupKey) => {
    const t = (newTitles[group] ?? '').trim();
    if (!t) return;
    const entry = addEntry(novelId, group, t);
    setNewTitles((s) => ({ ...s, [group]: '' }));
    setOpenGroups((s) => new Set(s).add(group));
    openArchitecture({ group, id: entry.id });
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-2">
      {/* 基本信息只读摘要：点击进入中央编辑器补全 */}
      <button
        type="button"
        onClick={() => openArchitecture()}
        className="rounded-xl border border-white/8 bg-white/3 p-2.5 text-left hover:border-brand-500/30 transition-colors"
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs font-semibold text-neutral-200">基本信息</span>
          <ExternalLink size={10} className="text-neutral-600" />
        </div>
        {basicFilled && basic ? (
          <div className="flex flex-col gap-0.5">
            {BASIC_LABELS.map(({ key, label }) =>
              basic[key]?.trim() ? (
                <p key={key} className="text-[10px] text-neutral-400 truncate">
                  <span className="text-neutral-600">{label} </span>
                  {basic[key]}
                </p>
              ) : null,
            )}
          </div>
        ) : (
          <p className="text-[10px] text-neutral-600">点击补全流派 / 主题 / 规划等</p>
        )}
      </button>

      {/* 四大组类：计数 + 条目导航 + 内联添加 */}
      {ARCH_GROUPS.map((g) => {
        const entries = arch?.[g.key] ?? [];
        const open = openGroups.has(g.key);
        return (
          <div key={g.key} className="rounded-xl border border-white/8 bg-white/3">
            <button
              type="button"
              onClick={() => toggleGroup(g.key)}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-left"
            >
              <span className="text-xs font-semibold text-neutral-200">{g.label}</span>
              <span className="text-[10px] text-neutral-600 tabular-nums">{entries.length}</span>
              <div className="flex-1" />
              {open ? (
                <ChevronUp size={13} className="text-neutral-500" />
              ) : (
                <ChevronDown size={13} className="text-neutral-500" />
              )}
            </button>
            {open && (
              <div className="px-3 pb-2.5 flex flex-col gap-1">
                {entries.length === 0 ? (
                  <p className="text-[10px] text-neutral-600 leading-relaxed">{g.description}</p>
                ) : (
                  entries.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => openArchitecture({ group: g.key, id: e.id })}
                      title={e.content?.trim() || e.title}
                      className="text-left px-1.5 py-1 rounded-md text-[11px] text-neutral-300 hover:bg-white/6 hover:text-neutral-100 truncate transition-colors"
                    >
                      {e.title.trim() || '未命名'}
                    </button>
                  ))
                )}
                {/* 内联快速添加（添加后跳转中央编辑器继续完善） */}
                <div className="flex items-center gap-1 mt-0.5">
                  <input
                    value={newTitles[g.key] ?? ''}
                    onChange={(e) => setNewTitles((s) => ({ ...s, [g.key]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd(g.key)}
                    placeholder={g.entryPlaceholder}
                    className={inputCls}
                  />
                  <button
                    type="button"
                    onClick={() => handleAdd(g.key)}
                    disabled={!(newTitles[g.key] ?? '').trim()}
                    title="添加条目并编辑"
                    className="shrink-0 p-1 rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    <Plus size={11} />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <p className="text-[10px] text-neutral-600 px-1 pb-1 leading-relaxed">
        点击条目在中央标签页编辑；架构内容默认作为 AIGC 上下文注入（可在各 AIGC 卡调整勾选）。
      </p>
    </div>
  );
};

export default ArchitecturePanel;
