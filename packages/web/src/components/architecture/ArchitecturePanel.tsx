import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useNovelStore } from '@/stores/novel-store';
import {
  useArchitectureStore,
  ARCH_GROUPS,
  type ArchGroupKey,
} from '@/stores/architecture-store';

/**
 * 小说架构面板（左侧板「架构」栏目，位于大纲右侧；备忘录 L61 预制）：
 * 参考记忆库的结构预制的成熟架构组类——基本信息（流派/主题/标签/规划章节数/
 * 规划每章字数/发布渠道）+ 核心线索 / 角色动力学 / 世界构建 / 情节构建。
 * 数据持久化在浏览器 localStorage（architecture-store），后续再接服务端。
 * 本面板同时是 AIGC 卡「架构」上下文线索的编辑入口。
 */

const BASIC_FIELDS: { key: 'genre' | 'theme' | 'tags' | 'plannedChapters' | 'wordsPerChapter' | 'channel'; label: string; placeholder: string }[] = [
  { key: 'genre', label: '流派', placeholder: '如：东方玄幻 / 都市悬疑' },
  { key: 'theme', label: '主题', placeholder: '如：成长与救赎' },
  { key: 'tags', label: '标签', placeholder: '如：#热血 #群像 #克苏鲁' },
  { key: 'plannedChapters', label: '规划章节数', placeholder: '如：120' },
  { key: 'wordsPerChapter', label: '规划每章字数', placeholder: '如：2500' },
  { key: 'channel', label: '发布渠道', placeholder: '如：起点 / 番茄 / 公众号' },
];

const inputCls =
  'w-full min-w-0 rounded-md bg-white/5 border border-white/8 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors';

/** 单个条目行：标题 + 内容（就地编辑）+ 删除 */
const EntryRow: React.FC<{
  novelId: number;
  group: ArchGroupKey;
  id: string;
  title: string;
  content: string;
}> = ({ novelId, group, id, title, content }) => {
  const updateEntry = useArchitectureStore((s) => s.updateEntry);
  const removeEntry = useArchitectureStore((s) => s.removeEntry);
  return (
    <div className="rounded-lg border border-white/8 bg-white/3 p-2 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          value={title}
          onChange={(e) => updateEntry(novelId, group, id, { title: e.target.value })}
          placeholder="标题"
          className={`${inputCls} font-medium`}
        />
        <button
          type="button"
          onClick={() => removeEntry(novelId, group, id)}
          title="删除该条目"
          className="shrink-0 p-1 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => updateEntry(novelId, group, id, { content: e.target.value })}
        placeholder="展开说明（可选）…"
        rows={2}
        className={`${inputCls} resize-none`}
      />
    </div>
  );
};

/** 单个组类区块：标题行 + 条目列表 + 添加 */
const GroupSection: React.FC<{ novelId: number; groupKey: ArchGroupKey; label: string; description: string; placeholder: string }> = ({
  novelId,
  groupKey,
  label,
  description,
  placeholder,
}) => {
  const arch = useArchitectureStore((s) => s.byNovel[novelId]);
  const addEntry = useArchitectureStore((s) => s.addEntry);
  const [open, setOpen] = useState(groupKey === 'coreClues');
  const [newTitle, setNewTitle] = useState('');
  const entries = arch?.[groupKey] ?? [];

  const handleAdd = () => {
    const t = newTitle.trim();
    if (!t) return;
    addEntry(novelId, groupKey, t);
    setNewTitle('');
    setOpen(true);
  };

  return (
    <div className="rounded-xl border border-white/8 bg-white/3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold text-neutral-200">{label}</span>
        <span className="text-[10px] text-neutral-600 tabular-nums">{entries.length}</span>
        <div className="flex-1" />
        {open ? (
          <ChevronUp size={13} className="text-neutral-500" />
        ) : (
          <ChevronDown size={13} className="text-neutral-500" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-2.5 flex flex-col gap-1.5">
          <p className="text-[10px] text-neutral-600 leading-relaxed">{description}</p>
          {entries.map((e) => (
            <EntryRow key={e.id} novelId={novelId} group={groupKey} id={e.id} title={e.title} content={e.content} />
          ))}
          <div className="flex items-center gap-1.5">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder={placeholder}
              className={inputCls}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newTitle.trim()}
              title="添加条目"
              className="shrink-0 p-1.5 rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const ArchitecturePanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const novelId = currentNovel?.id;
  const ensure = useArchitectureStore((s) => s.ensure);
  const updateBasic = useArchitectureStore((s) => s.updateBasic);
  const arch = useArchitectureStore((s) => (novelId ? s.byNovel[novelId] : undefined));

  // 切换作品即初始化（流派预填基本信息）
  useEffect(() => {
    if (novelId) ensure(novelId, currentNovel?.genre);
  }, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!novelId) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-neutral-500">
        选择作品后管理小说架构
      </div>
    );
  }

  const basic = arch?.basic;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-2">
      {/* 基本信息（六字段：流派/主题/标签/规划章节数/规划每章字数/发布渠道） */}
      <div className="rounded-xl border border-white/8 bg-white/3 p-3 flex flex-col gap-2">
        <div className="text-xs font-semibold text-neutral-200">基本信息</div>
        <div className="grid grid-cols-2 gap-1.5">
          {BASIC_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[10px] text-neutral-500">{f.label}</span>
              <input
                value={basic?.[f.key] ?? ''}
                onChange={(e) => updateBasic(novelId, { [f.key]: e.target.value })}
                placeholder={f.placeholder}
                className={inputCls}
              />
            </label>
          ))}
        </div>
      </div>

      {/* 四大组类 */}
      {ARCH_GROUPS.map((g) => (
        <GroupSection
          key={g.key}
          novelId={novelId}
          groupKey={g.key}
          label={g.label}
          description={g.description}
          placeholder={g.entryPlaceholder}
        />
      ))}

      <p className="text-[10px] text-neutral-600 px-1 pb-1">
        架构内容默认作为 AIGC 上下文注入（可在各 AIGC 卡调整勾选）。
      </p>
    </div>
  );
};

export default ArchitecturePanel;
