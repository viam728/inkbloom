import React, { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  Plus,
  Trash2,
  Loader2,
  Search,
  Pin,
  PinOff,
  Pencil,
  ChevronRight,
  ChevronDown,
  GripVertical,
  Maximize2,
  X,
} from 'lucide-react';
import {
  useMemoryStore,
  sortMemoryItems,
  type MemoryType,
  type MemoryItem,
} from '@/stores/memory-store';
import { useMediaMemoryStore } from '@/stores/media-memory-store';
import { useNovelStore } from '@/stores/novel-store';
import { useTabStore } from '@/stores/tab-store';
import { useToast } from '@/components/common/Toast';
import { GROUP_CONFIG, GROUP_ORDER } from './memory-config';
import MemoryEditorModal, { type MemoryEditorPayload } from './MemoryEditorModal';
import MemoryExpandedView from './MemoryExpandedView';
import { htmlToPlainText } from '@/utils/html';

interface MemoryPanelProps {
  /** 记忆作用域：novel = 按作品隔离；media = 自媒体全局记忆 */
  scope?: 'novel' | 'media';
}

/** 稳定空数组引用：作 `?? []` 回退，避免每次渲染新建数组触发依赖它的 effect 循环 */
const EMPTY_ITEMS: MemoryItem[] = [];

/** 编辑窗口实例：多窗口并存，挂起（minimized）与全屏状态由面板集中管理 */
interface MemoryWindowState {
  key: string;
  /** 编辑已有条目；缺省 = 新建 */
  itemId?: string;
  /** 新建时的默认分组 */
  newType?: MemoryType;
  minimized: boolean;
  fullscreen: boolean;
}

/** 作品/自媒体记忆面板：人物卡 / 设定集 / 前情摘要 / 灵感素材，为 AI 提供长期上下文 */
const MemoryPanel: React.FC<MemoryPanelProps> = ({ scope = 'novel' }) => {
  const isMedia = scope === 'media';
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const {
    byNovel,
    loading: novelLoading,
    loadMemory,
    addItem,
    updateItem,
    togglePin,
    removeItem,
    reorderItems: reorderNovelItems,
  } = useMemoryStore();
  const {
    items: mediaItems,
    loading: mediaLoading,
    loadMemory: loadMediaMemory,
    addItem: addMediaItem,
    updateItem: updateMediaItem,
    togglePin: toggleMediaPin,
    removeItem: removeMediaItem,
    reorderItems: reorderMediaItems,
  } = useMediaMemoryStore();
  const { showToast } = useToast();

  // ── 搜索与快捷标签 ─────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const quickTagsKey = `inkbloom-quick-tags-${scope}`;
  const [quickTags, setQuickTags] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(quickTagsKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(quickTagsKey, JSON.stringify(quickTags));
    } catch {
      /* ignore */
    }
  }, [quickTags, quickTagsKey]);

  // ── 分组折叠 / 拖拽 / 弹窗 ─────────────────────────────────────────
  const [collapsed, setCollapsed] = useState<Partial<Record<MemoryType, boolean>>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  /** 编辑窗口列表：打开编辑/新建时 push，关闭时移除；支持最小化挂起与全屏 */
  const [windows, setWindows] = useState<MemoryWindowState[]>([]);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // ── 作用域适配层：novel 绑定 currentNovel，media 为全局单份 ────────
  const novelId = isMedia ? undefined : currentNovel?.id;
  const items = isMedia ? mediaItems : (novelId ? byNovel[novelId] : undefined) ?? EMPTY_ITEMS;
  const loading = isMedia ? mediaLoading : novelLoading;

  /** 统一增删改签名，两个 scope 共享下方渲染与交互逻辑 */
  const doAdd = (payload: Omit<MemoryItem, 'id' | 'created_at' | 'updated_at'>) =>
    isMedia ? addMediaItem(payload) : novelId ? addItem(novelId, payload) : Promise.resolve();
  const doUpdate = (itemId: string, patch: Partial<Omit<MemoryItem, 'id'>>) =>
    isMedia ? updateMediaItem(itemId, patch) : novelId ? updateItem(novelId, itemId, patch) : Promise.resolve();
  const doTogglePin = (itemId: string) =>
    isMedia ? toggleMediaPin(itemId) : novelId ? togglePin(novelId, itemId) : Promise.resolve();
  const doRemove = (itemId: string) =>
    isMedia ? removeMediaItem(itemId) : novelId ? removeItem(novelId, itemId) : Promise.resolve();
  const doReorder = (orderedIds: string[]) =>
    isMedia ? reorderMediaItems(orderedIds) : novelId ? reorderNovelItems(novelId, orderedIds) : Promise.resolve();

  /** 全部标签及出现次数（快捷标签云数据源） */
  const allTags = useMemo(() => {
    const count = new Map<string, number>();
    items.forEach((i) => i.tags.forEach((t) => count.set(t, (count.get(t) ?? 0) + 1)));
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  /** 条目是否命中 搜索 + 快捷标签筛选（快捷标签=交集，无选中=不过滤） */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (i: MemoryItem) => {
      if (quickTags.length > 0 && !i.tags.some((t) => quickTags.includes(t))) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        htmlToPlainText(i.content).toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
      );
    };
  }, [query, quickTags]);

  /** 无筛选时允许组内拖拽（避免过滤视图下排序语义歧义） */
  const canDrag = quickTags.length === 0 && query.trim() === '';

  /** 四分组：组内 sortMemoryItems + 当前筛选 */
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((type) => {
        const groupItems = items.filter((i) => i.type === type);
        return {
          type,
          cfg: GROUP_CONFIG[type],
          total: groupItems.length,
          items: sortMemoryItems(groupItems.filter(matches)),
        };
      }),
    [items, matches],
  );

  /** 未过滤的完整分组（拖拽排序基于此构建全局 order） */
  const fullGroups = useMemo(() => {
    const map = new Map<MemoryType, MemoryItem[]>();
    for (const t of GROUP_ORDER) map.set(t, sortMemoryItems(items.filter((i) => i.type === t)));
    return map;
  }, [items]);

  useEffect(() => {
    if (isMedia) {
      loadMediaMemory();
    } else if (novelId) {
      loadMemory(novelId);
    }
    setQuery('');
    setDeleteConfirm(null);
    // 切换作用域/作品：既有编辑窗口的条目归属失效，统一关闭
    setWindows([]);
  }, [isMedia, novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 条目被删除后，关闭对应的编辑窗口（加载完成后的空列表才算真删除）
  useEffect(() => {
    if (loading) return;
    setWindows((ws) => {
      const next = ws.filter((w) => !w.itemId || items.some((i) => i.id === w.itemId));
      // 无变化时返回原引用，避免无谓重渲染
      return next.length === ws.length ? ws : next;
    });
  }, [items, loading]);

  if (!isMedia && !novelId) {
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

  // ── 交互 ───────────────────────────────────────────────────────────
  const toggleQuickTag = (tag: string) =>
    setQuickTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const openCreate = (type: MemoryType) => {
    setAddPickerOpen(false);
    // novel 作用域：编辑器为中央标签页；media 作用域保持多窗口弹窗
    if (!isMedia && novelId) {
      useTabStore
        .getState()
        .openPanelTab(`memory-new-${type}`, `新建${GROUP_CONFIG[type].label}`, 'memory', {
          newType: type,
          novelId,
        });
      return;
    }
    setWindows((ws) => [
      ...ws,
      { key: crypto.randomUUID(), newType: type, minimized: false, fullscreen: false },
    ]);
  };

  const openEdit = (item: MemoryItem) => {
    setDeleteConfirm(null);
    if (!isMedia && novelId) {
      useTabStore.getState().openPanelTab(`memory-${item.id}`, item.name, 'memory', {
        itemId: item.id,
        novelId,
      });
      return;
    }
    setWindows((ws) => {
      const existing = ws.find((w) => w.itemId === item.id);
      if (existing) {
        // 已存在同条目窗口：激活/恢复（取消挂起）
        return ws.map((w) => (w.key === existing.key ? { ...w, minimized: false } : w));
      }
      return [...ws, { key: crypto.randomUUID(), itemId: item.id, minimized: false, fullscreen: false }];
    });
  };

  const closeWindow = (key: string) => setWindows((ws) => ws.filter((w) => w.key !== key));

  const patchWindow = (key: string, patch: Partial<MemoryWindowState>) =>
    setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, ...patch } : w)));

  const handleEditorSubmit = async (win: MemoryWindowState, payload: MemoryEditorPayload) => {
    if (!isMedia && !novelId) return;
    if (win.itemId) {
      await doUpdate(win.itemId, payload);
      showToast('记忆条目已更新', 'success');
    } else {
      await doAdd(payload);
      showToast(isMedia ? '已加入全局记忆' : '已加入作品记忆', 'success');
    }
  };

  const handleDelete = async (item: MemoryItem) => {
    if (!isMedia && !novelId) return;
    await doRemove(item.id);
    setDeleteConfirm(null);
    showToast(`已删除「${item.name}」`, 'info');
  };

  /**
   * 组内拖拽 drop：
   * 1. 基于未过滤的完整组列表计算新 id 序列；
   * 2. 合并为全局有序 id（拖拽组用新顺序，其他组保持当前顺序）；
   * 3. 一次性调 reorderItems，保证 order=index 全局唯一，不与其他组碰撞。
   */
  const handleDrop = (type: MemoryType, targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const groupIds = (fullGroups.get(type) ?? []).map((i) => i.id);
    const from = groupIds.indexOf(draggingId);
    const to = groupIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    groupIds.splice(to, 0, ...groupIds.splice(from, 1));
    const merged: string[] = [];
    for (const t of GROUP_ORDER) {
      merged.push(...(t === type ? groupIds : (fullGroups.get(t) ?? []).map((i) => i.id)));
    }
    void doReorder(merged);
  };

  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="flex flex-col h-full">
      {/* 面板头部 */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Brain size={14} className="text-brand-300" />
        <span className="text-xs font-semibold text-neutral-200">
          {isMedia ? '全局记忆' : '作品记忆'}
        </span>
        <span className="text-[10px] text-neutral-600">{items.length}</span>
        <div className="flex-1" />
        <button
          onClick={() => setExpandedOpen(true)}
          title="记忆管理 · 展开视图"
          className="p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
        >
          <Maximize2 size={13} />
        </button>
        <button
          onClick={() => setAddPickerOpen((v) => !v)}
          title="添加记忆条目"
          className="p-1 rounded-md text-brand-300 hover:bg-brand-500/15 transition-colors"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 搜索框 */}
      <div className="px-3 pt-1">
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

      {/* 快捷标签筛选区：点选加入/移除，持久化 localStorage */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2">
          {allTags.slice(0, 12).map(([tag]) => {
            const active = quickTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleQuickTag(tag)}
                title={active ? '点击移除快捷标签' : '点击加入快捷标签筛选'}
                className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                  active
                    ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                    : 'bg-white/5 text-neutral-500 border-white/8 hover:text-neutral-300'
                }`}
              >
                #{tag}
                {active && <X size={8} />}
              </button>
            );
          })}
          {quickTags.length > 0 && (
            <button
              onClick={() => setQuickTags([])}
              className="text-[10px] text-neutral-600 hover:text-neutral-300 transition-colors"
            >
              清空
            </button>
          )}
        </div>
      )}

      {/* 添加条目：内联分组选择 */}
      {addPickerOpen && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-white/8 bg-white/3 p-2 animate-fade-in">
            <span className="text-[11px] text-neutral-500">选择分组：</span>
            {GROUP_ORDER.map((t) => {
              const Icon = GROUP_CONFIG[t].icon;
              return (
                <button
                  key={t}
                  onClick={() => openCreate(t)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/8 text-neutral-400 hover:bg-white/10 hover:text-neutral-200 transition-colors"
                >
                  <Icon size={11} className={GROUP_CONFIG[t].color} />
                  {GROUP_CONFIG[t].label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 分组折叠区块列表 */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-neutral-500">
            <Loader2 size={13} className="animate-spin text-brand-400" />
            {isMedia ? '加载全局记忆…' : '加载作品记忆…'}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-4 py-10">
            <Brain size={24} className="text-neutral-700 mb-2.5" />
            <p className="text-xs text-neutral-500 leading-relaxed">
              暂无记忆条目
              <br />
              <span className="text-neutral-600">
                {isMedia ? '全局记忆，所有自媒体内容共享' : 'AI 对话与续写时会参考这些长期记忆'}
              </span>
            </p>
            <button
              onClick={() => setAddPickerOpen(true)}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 transition-all shadow-lg shadow-brand-600/20"
            >
              <Plus size={12} />
              添加第一条记忆
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleCount === 0 && (
              <p className="text-[11px] text-neutral-600 px-1 py-2">没有匹配的记忆条目</p>
            )}
            {groups.map(({ type, cfg, items: groupItems, total }) => {
              const Icon = cfg.icon;
              const isCollapsed = !!collapsed[type];
              return (
                <div key={type} className="rounded-lg border border-white/6 bg-white/2">
                  {/* 组头：参照 OutlinePanel ActBlock */}
                  <div className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-white/4 transition-colors">
                    <button
                      onClick={() => setCollapsed((prev) => ({ ...prev, [type]: !isCollapsed }))}
                      className="shrink-0 p-0.5 text-neutral-500 hover:text-neutral-300 transition-colors"
                    >
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <Icon size={12} className={`${cfg.color} shrink-0`} />
                    <span className="text-xs font-semibold text-neutral-200 truncate">{cfg.label}</span>
                    <span className="text-[10px] text-neutral-600">{total}</span>
                    <div className="flex-1" />
                    <button
                      onClick={() => openCreate(type)}
                      title={`添加${cfg.label}条目`}
                      className="p-0.5 rounded text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-brand-300 hover:bg-brand-500/10 transition-all"
                    >
                      <Plus size={11} />
                    </button>
                  </div>

                  {/* 组内条目卡 */}
                  {!isCollapsed && (
                    <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
                      {groupItems.length === 0 ? (
                        <p className="text-[11px] text-neutral-600 px-1.5 py-1.5">
                          {total === 0 ? '暂无条目' : '无匹配条目'}
                        </p>
                      ) : (
                        groupItems.map((item) => {
                          const isDragging = draggingId === item.id;
                          const isDragOver = dragOverId === item.id && draggingId !== item.id;
                          const preview = htmlToPlainText(item.content);
                          return (
                            <div
                              key={item.id}
                              draggable={canDrag}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                setDraggingId(item.id);
                              }}
                              onDragOver={(e) => {
                                if (!canDrag) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                                if (dragOverId !== item.id) setDragOverId(item.id);
                              }}
                              onDragLeave={() => {
                                if (dragOverId === item.id) setDragOverId(null);
                              }}
                              onDrop={(e) => {
                                if (!canDrag) return;
                                e.preventDefault();
                                handleDrop(type, item.id);
                              }}
                              onDragEnd={() => {
                                setDraggingId(null);
                                setDragOverId(null);
                              }}
                              onClick={() => openEdit(item)}
                              className={`group relative rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                                item.pinned
                                  ? 'bg-brand-500/8 border-brand-500/25 hover:border-brand-500/40'
                                  : 'bg-white/3 border-white/6 hover:border-white/12'
                              } ${isDragging ? 'opacity-40' : ''} ${isDragOver ? 'ring-1 ring-brand-500/60' : ''}`}
                            >
                              {/* 拖拽 hover 目标：左侧"可移动"提示标 */}
                              {isDragOver && (
                                <span
                                  title="可移动"
                                  className="absolute left-0.5 top-1/2 -translate-y-1/2 text-brand-300 animate-fade-in"
                                >
                                  <GripVertical size={12} />
                                </span>
                              )}
                              <div className="flex items-center gap-1.5 mb-0.5">
                                {canDrag && (
                                  <span
                                    title="拖动调顺序"
                                    className="shrink-0 text-neutral-700 opacity-0 group-hover:opacity-100 cursor-grab transition-opacity"
                                  >
                                    <GripVertical size={11} />
                                  </span>
                                )}
                                {item.pinned && (
                                  /* 置顶 / AI 优先 */
                                  <Pin size={10} className="text-brand-300 shrink-0" />
                                )}
                                <span className="flex-1 text-xs font-medium text-neutral-200 truncate">
                                  {item.name}
                                </span>
                                {/* 悬停操作 */}
                                <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      doTogglePin(item.id);
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
                              {preview && (
                                <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-2">
                                  {preview}
                                </p>
                              )}
                              {item.tags.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                                  {item.tags.map((tag) => (
                                    <span
                                      key={tag}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleQuickTag(tag);
                                      }}
                                      title="加入/移除快捷标签筛选"
                                      className={`text-[9px] px-1.5 py-0.5 rounded-full cursor-pointer transition-colors ${
                                        quickTags.includes(tag)
                                          ? 'bg-brand-600/25 text-brand-300'
                                          : 'bg-white/6 text-neutral-500 hover:text-neutral-300'
                                      }`}
                                    >
                                      #{tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 新建 / 编辑窗口列表：多实例并存，各自受控挂起/全屏 */}
      {windows.map((w) => (
        <MemoryEditorModal
          key={w.key}
          open
          onClose={() => closeWindow(w.key)}
          scope={scope}
          novelId={novelId}
          item={w.itemId ? (items.find((i) => i.id === w.itemId) ?? null) : null}
          defaultType={w.newType ?? 'character'}
          minimized={w.minimized}
          onMinimize={(m) => patchWindow(w.key, { minimized: m })}
          fullscreen={w.fullscreen}
          onToggleFullscreen={() => patchWindow(w.key, { fullscreen: !w.fullscreen })}
          allItems={items}
          instanceKey={w.key}
          onSubmit={(payload) => handleEditorSubmit(w, payload)}
        />
      ))}

      {/* 展开大视图：点击卡片先关闭大视图再打开编辑弹窗（Modal Esc 为 window capture，禁止嵌套） */}
      <MemoryExpandedView
        open={expandedOpen}
        onClose={() => setExpandedOpen(false)}
        items={items}
        onEdit={(item) => {
          setExpandedOpen(false);
          openEdit(item);
        }}
      />
    </div>
  );
};

export default MemoryPanel;
