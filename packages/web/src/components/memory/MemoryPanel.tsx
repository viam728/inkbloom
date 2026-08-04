import React, { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  Plus,
  Trash2,
  Loader2,
  User,
  Map as MapIcon,
  ScrollText,
  Search,
  Pin,
  PinOff,
  Pencil,
} from 'lucide-react';
import {
  useMemoryStore,
  sortMemoryItems,
  type MemoryType,
  type MemoryItem,
} from '@/stores/memory-store';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';
import Modal from '@/components/common/Modal';

const TYPE_CONFIG: Record<
  MemoryType,
  { label: string; icon: React.ReactNode; color: string }
> = {
  character: { label: '人物卡', icon: <User size={12} />, color: 'text-pink-300' },
  setting: { label: '设定集', icon: <MapIcon size={12} />, color: 'text-sky-300' },
  summary: { label: '前情摘要', icon: <ScrollText size={12} />, color: 'text-amber-300' },
};

const fmtTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
};

/** 作品记忆面板：人物卡 / 设定集 / 前情摘要，为 AI 提供长期上下文 */
const MemoryPanel: React.FC = () => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const { byNovel, loading, loadMemory, addItem, updateItem, togglePin, removeItem } =
    useMemoryStore();
  const { showToast } = useToast();

  // ── 查询与筛选 ───────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // ── 表单弹窗（新建 / 编辑共用） ─────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MemoryItem | null>(null);
  const [formType, setFormType] = useState<MemoryType>('character');
  const [formName, setFormName] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formPinned, setFormPinned] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const novelId = currentNovel?.id;
  const items = (novelId ? byNovel[novelId] : undefined) ?? [];

  /** 全部标签及出现次数（用于标签筛选） */
  const allTags = useMemo(() => {
    const count = new Map<string, number>();
    items.forEach((i) => i.tags.forEach((t) => count.set(t, (count.get(t) ?? 0) + 1)));
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  /** 搜索 + 类型筛选 + 标签筛选 + 置顶/更新时间排序 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortMemoryItems(
      items.filter((i) => {
        if (filter !== 'all' && i.type !== filter) return false;
        if (tagFilter && !i.tags.includes(tagFilter)) return false;
        if (!q) return true;
        return (
          i.name.toLowerCase().includes(q) ||
          i.content.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q))
        );
      }),
    );
  }, [items, filter, tagFilter, query]);

  useEffect(() => {
    if (novelId) loadMemory(novelId);
    setQuery('');
    setFilter('all');
    setTagFilter(null);
  }, [novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!novelId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6 py-10">
        <Brain size={26} className="text-neutral-600 mb-3" />
        <p className="text-xs text-neutral-500 leading-relaxed">
          先选择一部作品，
          <br />
          再管理它的人物卡、设定与前情摘要
        </p>
      </div>
    );
  }

  const openCreate = () => {
    setEditTarget(null);
    setFormType(filter !== 'all' ? filter : 'character');
    setFormName('');
    setFormContent('');
    setFormTags('');
    setFormPinned(false);
    setFormOpen(true);
  };

  const openEdit = (item: MemoryItem) => {
    setEditTarget(item);
    setFormType(item.type);
    setFormName(item.name);
    setFormContent(item.content);
    setFormTags(item.tags.join(', '));
    setFormPinned(!!item.pinned);
    setFormOpen(true);
    setDeleteConfirm(null);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditTarget(null);
  };

  const parseTags = (raw: string) =>
    raw
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

  const handleSubmit = async () => {
    if (!formName.trim() || !novelId) return;
    const payload = {
      type: formType,
      name: formName.trim(),
      content: formContent.trim(),
      tags: parseTags(formTags),
      pinned: formPinned,
    };
    if (editTarget) {
      await updateItem(novelId, editTarget.id, payload);
      showToast('记忆条目已更新', 'success');
    } else {
      await addItem(novelId, payload);
      showToast('已加入作品记忆', 'success');
    }
    closeForm();
  };

  const handleDelete = async (item: MemoryItem) => {
    if (!novelId) return;
    await removeItem(novelId, item.id);
    if (tagFilter && !items.some((i) => i.id !== item.id && i.tags.includes(tagFilter))) {
      setTagFilter(null);
    }
    setDeleteConfirm(null);
    showToast(`已删除「${item.name}」`, 'info');
  };

  const inputCls =
    'w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-[13px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all';

  return (
    <div className="flex flex-col h-full">
      {/* 搜索框 */}
      <div className="px-3 pt-2">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600 pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 内容 / 标签…"
            className="w-full rounded-lg bg-white/5 border border-white/10 pl-7 pr-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
          />
        </div>
      </div>

      {/* 类型过滤 */}
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          onClick={() => setFilter('all')}
          className={`text-[11px] px-2 py-1 rounded-md transition-colors ${
            filter === 'all' ? 'bg-brand-600/25 text-brand-300' : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
          }`}
        >
          全部 {items.length}
        </button>
        {(Object.keys(TYPE_CONFIG) as MemoryType[]).map((t) => (
          <button
            key={t}
            onClick={() => setFilter(filter === t ? 'all' : t)}
            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${
              filter === t ? 'bg-brand-600/25 text-brand-300' : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
            }`}
          >
            {TYPE_CONFIG[t].label} {items.filter((i) => i.type === t).length}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={openCreate}
          title="添加记忆条目"
          className="p-1 rounded-md text-brand-300 hover:bg-brand-500/15 transition-colors"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 标签筛选 */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {allTags.slice(0, 8).map(([tag, count]) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                tagFilter === tag
                  ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                  : 'bg-white/5 text-neutral-500 border-white/8 hover:text-neutral-300'
              }`}
            >
              #{tag} {count > 1 ? count : ''}
            </button>
          ))}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-neutral-500">
            <Loader2 size={13} className="animate-spin text-brand-400" />
            加载作品记忆…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-4 py-10">
            <Brain size={24} className="text-neutral-700 mb-2.5" />
            <p className="text-xs text-neutral-500 leading-relaxed">
              {query || tagFilter
                ? '没有匹配的记忆条目'
                : `暂无${filter !== 'all' ? TYPE_CONFIG[filter].label : '记忆条目'}`}
              <br />
              <span className="text-neutral-600">AI 对话与续写时会参考这些长期记忆</span>
            </p>
            {items.length === 0 && (
              <button
                onClick={openCreate}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 transition-all shadow-lg shadow-brand-600/20"
              >
                <Plus size={12} />
                添加第一条记忆
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map((item) => (
              <div
                key={item.id}
                onClick={() => openEdit(item)}
                className={`group rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                  item.pinned
                    ? 'bg-brand-500/8 border-brand-500/25 hover:border-brand-500/40'
                    : 'bg-white/3 border-white/6 hover:border-white/12'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {item.pinned && <Pin size={10} className="text-brand-300 shrink-0" />}
                  <span className={`${TYPE_CONFIG[item.type].color}`}>
                    {TYPE_CONFIG[item.type].icon}
                  </span>
                  <span className="flex-1 text-xs font-medium text-neutral-200 truncate">
                    {item.name}
                  </span>
                  {/* 悬停操作 */}
                  <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (novelId) togglePin(novelId, item.id);
                      }}
                      title={item.pinned ? '取消置顶' : '置顶（AI 优先参考）'}
                      className="p-0.5 rounded text-neutral-600 hover:text-brand-300 hover:bg-brand-500/10 transition-colors"
                    >
                      {item.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(item);
                      }}
                      title="编辑条目"
                      className="p-0.5 rounded text-neutral-600 hover:text-neutral-200 hover:bg-white/8 transition-colors"
                    >
                      <Pencil size={11} />
                    </button>
                    {deleteConfirm === item.id ? (
                      <span className="flex gap-1 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleDelete(item)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
                        >
                          确认
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-neutral-300 hover:bg-white/15 transition-colors"
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm(item.id);
                        }}
                        title="删除条目"
                        className="p-0.5 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </span>
                </div>
                {item.content && (
                  <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-3 whitespace-pre-line">
                    {item.content}
                  </p>
                )}
                {(item.tags.length > 0 || item.updated_at) && (
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTagFilter(tagFilter === tag ? null : tag);
                        }}
                        className={`text-[9px] px-1.5 py-0.5 rounded-full cursor-pointer transition-colors ${
                          tagFilter === tag
                            ? 'bg-brand-600/25 text-brand-300'
                            : 'bg-white/6 text-neutral-500 hover:text-neutral-300'
                        }`}
                      >
                        #{tag}
                      </span>
                    ))}
                    {item.updated_at && (
                      <span className="ml-auto text-[9px] text-neutral-600 tabular-nums">
                        {fmtTime(item.updated_at)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建 / 编辑弹窗 */}
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={editTarget ? '编辑记忆条目' : '添加记忆条目'}
        width="480px"
      >
        <div className="px-5 py-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            {(Object.keys(TYPE_CONFIG) as MemoryType[]).map((t) => (
              <button
                key={t}
                onClick={() => setFormType(t)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                  formType === t
                    ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                    : 'bg-white/5 text-neutral-400 border-white/8 hover:bg-white/10'
                }`}
              >
                {TYPE_CONFIG[t].icon}
                {TYPE_CONFIG[t].label}
              </button>
            ))}
          </div>
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="名称（如：林晚）"
            className={inputCls}
            autoFocus
          />
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder={
              formType === 'character'
                ? '人物设定：性格、外貌、动机、与他人的关系…'
                : formType === 'setting'
                  ? '世界观 / 地点 / 规则 / 时代背景…'
                  : '已发生的关键剧情，供后续章节保持连贯…'
            }
            rows={7}
            className={`${inputCls} resize-none leading-6`}
          />
          <input
            value={formTags}
            onChange={(e) => setFormTags(e.target.value)}
            placeholder="标签（逗号分隔，可选，如：主角, 反派, 关键道具）"
            className={inputCls}
          />
          <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={formPinned}
              onChange={(e) => setFormPinned(e.target.checked)}
              className="accent-indigo-500"
            />
            置顶条目（始终排在最前，AI 生成时优先携带）
          </label>
          <div className="flex justify-end gap-2 mt-1">
            <button
              onClick={closeForm}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={!formName.trim()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-indigo-600/20"
            >
              {editTarget ? '保存修改' : '保存条目'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default MemoryPanel;
