import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useArchitectureStore,
  ARCH_GROUPS,
  type ArchGroupKey,
  type ArchEntry,
  type ArchBasicInfo,
} from '@/stores/architecture-store';

/**
 * 小说架构中央编辑器（Home tab「小说架构」，架构栏重构后编辑主战场）：
 * 左右分栏——左侧组类/条目导航（含各卷内联添加），右侧选中条目的
 * 标题 + 内容宽幅编辑区。数据仍走 architecture-store（localStorage），
 * 与左侧导航器共享同一数据源，AIGC 线索注入链路零影响。
 */

const inputCls =
  'w-full min-w-0 rounded-md bg-white/5 border border-white/8 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors';

const BASIC_LABELS: { key: keyof ArchBasicInfo; label: string }[] = [
  { key: 'genre', label: '流派' },
  { key: 'theme', label: '主题' },
  { key: 'tags', label: '标签' },
  { key: 'plannedChapters', label: '规划章节' },
  { key: 'wordsPerChapter', label: '每章字数' },
  { key: 'channel', label: '发布渠道' },
];

interface Selection {
  group: ArchGroupKey;
  id: string;
}

const ArchitectureEditor: React.FC<{ novelId?: number }> = ({ novelId }) => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const ensure = useArchitectureStore((s) => s.ensure);
  const updateBasic = useArchitectureStore((s) => s.updateBasic);
  const addEntry = useArchitectureStore((s) => s.addEntry);
  const updateEntry = useArchitectureStore((s) => s.updateEntry);
  const removeEntry = useArchitectureStore((s) => s.removeEntry);
  const focus = useArchitectureStore((s) => s.focus);
  const setFocus = useArchitectureStore((s) => s.setFocus);
  const arch = useArchitectureStore((s) => (novelId != null ? s.byNovel[novelId] : undefined));

  const [sel, setSel] = useState<Selection | null>(null);
  const [newTitles, setNewTitles] = useState<Partial<Record<ArchGroupKey, string>>>({});

  // 切换作品即初始化（流派预填基本信息），与左侧导航器同一入口
  useEffect(() => {
    if (novelId != null) ensure(novelId, currentNovel?.genre);
  }, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 左侧导航的焦点定位：消费后清除（支持导航点击直接选中对应条目）
  useEffect(() => {
    if (focus) {
      setSel(focus);
      setFocus(null);
    }
  }, [focus, setFocus]);

  if (novelId == null) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
        选择作品后管理小说架构
      </div>
    );
  }

  const selected: ArchEntry | null =
    sel && arch ? (arch[sel.group] ?? []).find((e) => e.id === sel.id) ?? null : null;

  const handleAdd = (group: ArchGroupKey) => {
    const t = (newTitles[group] ?? '').trim();
    if (!t) return;
    const entry = addEntry(novelId, group, t);
    setNewTitles((s) => ({ ...s, [group]: '' }));
    setSel({ group, id: entry.id });
  };

  const basic = arch?.basic;

  return (
    <div className="flex-1 min-h-0 flex">
      {/* 左侧：组类/条目导航 */}
      <aside className="w-60 shrink-0 border-r border-white/6 bg-surface-1 overflow-y-auto p-2 flex flex-col gap-2">
        {/* 基本信息摘要（只读；编辑在右侧/下方基本信息区） */}
        <div className="rounded-lg border border-white/8 bg-white/3 p-2.5">
          <div className="text-[11px] font-semibold text-neutral-200 mb-1.5">基本信息</div>
          {basic && BASIC_LABELS.some((f) => basic[f.key]?.trim()) ? (
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
            <p className="text-[10px] text-neutral-600">尚未填写，在右侧补全</p>
          )}
        </div>

        {ARCH_GROUPS.map((g) => {
          const entries = arch?.[g.key] ?? [];
          return (
            <div key={g.key} className="rounded-lg border border-white/8 bg-white/3 p-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-neutral-200">{g.label}</span>
                <span className="text-[10px] text-neutral-600 tabular-nums">{entries.length}</span>
              </div>
              {entries.length === 0 ? (
                <p className="text-[10px] text-neutral-600 leading-relaxed">{g.description}</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {entries.map((e) => {
                    const active = sel?.group === g.key && sel.id === e.id;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setSel({ group: g.key, id: e.id })}
                        title={e.content?.trim() || e.title}
                        className={`text-left px-1.5 py-1 rounded-md text-[11px] truncate transition-colors ${
                          active
                            ? 'bg-brand-600/20 text-brand-200'
                            : 'text-neutral-300 hover:bg-white/6 hover:text-neutral-100'
                        }`}
                      >
                        {e.title.trim() || '未命名'}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 内联添加 */}
              <div className="flex items-center gap-1">
                <input
                  value={newTitles[g.key] ?? ''}
                  onChange={(e) => setNewTitles((s) => ({ ...s, [g.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && handleAdd(g.key)}
                  placeholder={g.entryPlaceholder}
                  className={`${inputCls} !py-1 !text-[10px]`}
                />
                <button
                  type="button"
                  onClick={() => handleAdd(g.key)}
                  disabled={!(newTitles[g.key] ?? '').trim()}
                  title="添加条目"
                  className="shrink-0 p-1 rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  <Plus size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </aside>

      {/* 右侧：选中条目宽幅编辑区 */}
      <section className="flex-1 min-w-0 flex flex-col px-6 py-4 overflow-hidden">
        {selected && sel ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/12 text-violet-300 border border-violet-500/25">
                {ARCH_GROUPS.find((g) => g.key === sel.group)?.label}
              </span>
              <input
                value={selected.title}
                onChange={(e) =>
                  updateEntry(novelId, sel.group, sel.id, { title: e.target.value })
                }
                placeholder="条目标题"
                className="flex-1 min-w-0 bg-transparent text-lg font-semibold tracking-tight text-neutral-100 placeholder-neutral-600 outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  removeEntry(novelId, sel.group, sel.id);
                  setSel(null);
                }}
                title="删除该条目"
                className="shrink-0 p-1.5 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <textarea
              value={selected.content}
              onChange={(e) =>
                updateEntry(novelId, sel.group, sel.id, { content: e.target.value })
              }
              placeholder={'展开说明（可选）……\n此内容默认作为 AIGC 上下文注入（可在各 AIGC 卡调整勾选）。'}
              className="flex-1 min-h-0 w-full resize-none rounded-lg border border-white/10 bg-white/4 px-3 py-2.5 text-sm leading-relaxed text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
            />
          </>
        ) : (
          <>
            {/* 无选中条目：编辑基本信息 */}
            <div className="text-xs font-semibold text-neutral-200 mb-3">基本信息</div>
            <div className="grid grid-cols-2 gap-3 max-w-xl">
              {(
                [
                  ['genre', '流派', '如：东方玄幻 / 都市悬疑'],
                  ['theme', '主题', '如：成长与救赎'],
                  ['tags', '标签', '如：#热血 #群像 #克苏鲁'],
                  ['plannedChapters', '规划章节数', '如：120'],
                  ['wordsPerChapter', '规划每章字数', '如：2500'],
                  ['channel', '发布渠道', '如：起点 / 番茄 / 公众号'],
                ] as const
              ).map(([key, label, placeholder]) => (
                <label key={key} className="flex flex-col gap-1 min-w-0">
                  <span className="text-[10px] text-neutral-500">{label}</span>
                  <input
                    value={basic?.[key] ?? ''}
                    onChange={(e) => updateBasic(novelId, { [key]: e.target.value })}
                    placeholder={placeholder}
                    className={inputCls}
                  />
                </label>
              ))}
            </div>
            <p className="mt-4 text-[11px] text-neutral-500 leading-relaxed max-w-xl">
              从左侧选择一个条目开始编辑；或直接在上方补全基本信息。
              架构内容默认作为 AIGC 上下文注入（可在各 AIGC 卡调整勾选）。
            </p>
          </>
        )}
      </section>
    </div>
  );
};

export default ArchitectureEditor;
