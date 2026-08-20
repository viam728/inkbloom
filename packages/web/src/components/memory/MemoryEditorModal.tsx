import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import Modal from '@/components/common/Modal';
import TipTapEditor from '@/components/editor/TipTapEditor';
import { useToast } from '@/components/common/Toast';
import { GROUP_CONFIG, GROUP_ORDER, MEMORY_TAB_META, type MemoryTab } from './memory-config';
import { parseTags, formatTags } from '@/utils/tags';
import { escapeHtml } from '@/utils/html';
import { useOutlineStore, type OutlineAct } from '@/stores/outline-store';
import type {
  MemoryItem,
  MemoryPortrait,
  MemoryRelation,
  MemoryType,
} from '@/stores/memory-store';
import { agentGenerate, generatePortraitImage, uploadPortrait } from '@/services/agent-client';

/** 提交载荷：不含 id / 时间戳（由 store 生成） */
export type MemoryEditorPayload = Omit<MemoryItem, 'id' | 'created_at' | 'updated_at'>;

interface MemoryEditorModalProps {
  open: boolean;
  onClose: () => void;
  /** 作用域：novel 才显示可见时机多选 */
  scope: 'novel' | 'media';
  novelId?: number;
  /** null = 新建 */
  item: MemoryItem | null;
  /** 新建时的默认分组 */
  defaultType?: MemoryType;
  onSubmit: (payload: MemoryEditorPayload) => Promise<void>;
  /** 受控最小化（多窗口挂起由宿主 MemoryPanel 管理） */
  minimized: boolean;
  onMinimize: (minimized: boolean) => void;
  /** 受控全屏 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 同库全部条目：人物关系目标候选 */
  allItems: MemoryItem[];
  /** 窗口实例标识：inkbloom:insert-content 定向投递 */
  instanceKey: string;
}

const NO_ACTS: OutlineAct[] = [];

const inputCls =
  'w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-[13px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all';

const smallInputCls =
  'flex-1 min-w-0 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors';

const ghostBtnCls =
  'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-white/10 bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-neutral-200 disabled:opacity-40 disabled:pointer-events-none transition-colors';

/** 小型开关 */
const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
      checked ? 'bg-brand-600' : 'bg-white/15'
    }`}
  >
    <span
      className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${
        checked ? 'left-[16px]' : 'left-[2px]'
      }`}
    />
  </button>
);

/** 人物关系行：目标条目下拉 ↔ 自由文本切换 + 关系/羁绊度/阵营/备注 */
const RelationRow: React.FC<{
  relation: MemoryRelation;
  candidates: MemoryItem[];
  onChange: (patch: Partial<MemoryRelation>) => void;
  onRemove: () => void;
}> = ({ relation, candidates, onChange, onRemove }) => {
  const selectMode = relation.target_id !== undefined;
  return (
    <div className="rounded-lg border border-white/8 bg-white/3 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {selectMode ? (
          <select
            value={relation.target_id}
            onChange={(e) => {
              const id = e.target.value;
              if (id === '') {
                // 切换为自由文本：保留已输入的 target_name
                onChange({ target_id: undefined });
                return;
              }
              const c = candidates.find((i) => i.id === id);
              onChange({ target_id: id, target_name: c?.name ?? relation.target_name });
            }}
            className={`${smallInputCls} cursor-pointer`}
          >
            <option value="">— 改为自由文本 —</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              value={relation.target_name}
              onChange={(e) => onChange({ target_name: e.target.value })}
              placeholder="目标名称（自由文本）"
              className={smallInputCls}
            />
            <button
              type="button"
              onClick={() => {
                const c = candidates[0];
                if (c) onChange({ target_id: c.id, target_name: c.name });
              }}
              disabled={candidates.length === 0}
              title={candidates.length === 0 ? '同库暂无其他条目可选' : '切换为从同库条目选择'}
              className={`${ghostBtnCls} shrink-0`}
            >
              选条目
            </button>
          </>
        )}
        <input
          value={relation.relation}
          onChange={(e) => onChange({ relation: e.target.value })}
          placeholder="关系类型，如：青梅竹马 / 宿敌"
          className={smallInputCls}
        />
        <button
          type="button"
          onClick={onRemove}
          title="删除该关系"
          className="p-1.5 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-neutral-600 shrink-0 w-16">羁绊度 {relation.bond ?? 50}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={relation.bond ?? 50}
          onChange={(e) => onChange({ bond: Number(e.target.value) })}
          className="flex-1 h-1 accent-brand-500 cursor-pointer"
        />
        <input
          value={relation.faction ?? ''}
          onChange={(e) => onChange({ faction: e.target.value })}
          placeholder="阵营"
          className={`${smallInputCls} max-w-[110px]`}
        />
      </div>
      <input
        value={relation.note ?? ''}
        onChange={(e) => onChange({ note: e.target.value })}
        placeholder="备注：相处细节、关键事件…"
        className={smallInputCls}
      />
    </div>
  );
};

/**
 * 记忆条目编辑弹窗（四 Tab：基本资料 / 人物关系 / 详情 / 立绘，按分组声明渲染）：
 * 支持受控最小化挂起与全屏（宿主管理状态，多窗口并存）；
 * 详情 Tab 内置 AIGC（agent/generate）预览插入与「一键加载基本资料」；
 * 立绘 Tab 支持上传与 AI 生成（复用 /aigc/prompt + /aigc/generate 链路）。
 */
const MemoryEditorModal: React.FC<MemoryEditorModalProps> = ({
  open,
  onClose,
  scope,
  novelId,
  item,
  defaultType = 'character',
  onSubmit,
  minimized,
  onMinimize,
  fullscreen,
  onToggleFullscreen,
  allItems,
  instanceKey,
}) => {
  const { showToast } = useToast();
  const [tab, setTab] = useState<MemoryTab>('profile');
  const [type, setType] = useState<MemoryType>(defaultType);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tagsRaw, setTagsRaw] = useState('');
  const [pinned, setPinned] = useState(false);
  const [aiVisible, setAiVisible] = useState(true);
  const [limitVisible, setLimitVisible] = useState(false);
  const [visibleChapters, setVisibleChapters] = useState<Set<string>>(new Set());
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [portraits, setPortraits] = useState<MemoryPortrait[]>([]);
  const [editorFocused, setEditorFocused] = useState(false);
  const [aigcLoading, setAigcLoading] = useState(false);
  const [aigcPreview, setAigcPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [aiPortraitLoading, setAiPortraitLoading] = useState(false);
  const [previewPortrait, setPreviewPortrait] = useState<MemoryPortrait | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadOutline = useOutlineStore((s) => s.loadOutline);
  const acts = useOutlineStore((s) => (novelId !== undefined ? s.byNovel[novelId] : undefined)) ?? NO_ACTS;

  // 打开时重置表单（多窗口场景下每个窗口是独立组件实例，挂载即初始化）
  useEffect(() => {
    if (!open) return;
    setTab('profile');
    setType(item?.type ?? defaultType);
    setName(item?.name ?? '');
    setContent(item?.content ?? '');
    setFields({ ...(item?.fields ?? {}) });
    setTagsRaw(formatTags(item?.tags ?? []));
    setPinned(!!item?.pinned);
    setAiVisible(item?.ai_visible !== false);
    setVisibleChapters(new Set(item?.visible_chapters ?? []));
    setLimitVisible((item?.visible_chapters?.length ?? 0) > 0);
    setRelations((item?.relations ?? []).map((r) => ({ ...r })));
    setPortraits((item?.portraits ?? []).map((p) => ({ ...p })));
    setEditorFocused(false);
    setAigcLoading(false);
    setAigcPreview(null);
    setPreviewPortrait(null);
    setSaving(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // novel scope：打开时拉取大纲供"限制可见性"候选
  useEffect(() => {
    if (open && scope === 'novel' && novelId !== undefined) void loadOutline(novelId);
  }, [open, scope, novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = GROUP_CONFIG[type];
  const showVisibility = scope === 'novel' && novelId !== undefined;

  const allNodeIds = useMemo(() => new Set(acts.flatMap((a) => a.nodes.map((n) => n.id))), [acts]);
  /** 已选但不在当前大纲中的节点 id */
  const staleIds = useMemo(
    () => [...visibleChapters].filter((id) => !allNodeIds.has(id)),
    [visibleChapters, allNodeIds],
  );
  const hasOutline = acts.some((a) => a.nodes.length > 0);

  /** 关系目标候选：同库其他条目 */
  const relationCandidates = useMemo(
    () => allItems.filter((i) => i.id !== item?.id),
    [allItems, item?.id],
  );

  const toggleNode = (nodeId: string) =>
    setVisibleChapters((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });

  /** 切换分组：目标分组不支持当前 Tab 时回退到基本资料 */
  const handleTypeChange = (t: MemoryType) => {
    setType(t);
    if (!GROUP_CONFIG[t].tabs.includes(tab)) setTab('profile');
  };

  /** 定向投递 HTML 到本弹窗的详情编辑器（insertTarget = 窗口 key） */
  const dispatchInsert = (html: string) => {
    window.dispatchEvent(
      new CustomEvent('inkbloom:insert-content', { detail: { html, target: instanceKey } }),
    );
  };

  /** 一键加载基本资料：非空 fields 按 `<h3>label</h3><p>value</p>` 拼成 HTML 插入光标处 */
  const loadFieldsToEditor = () => {
    const parts = cfg.fields
      .filter((f) => (fields[f.key] ?? '').trim() !== '')
      .map((f) => `<h3>${escapeHtml(f.label)}</h3><p>${escapeHtml(fields[f.key].trim())}</p>`);
    if (parts.length === 0) {
      showToast('暂无已填写的基本资料', 'info');
      return;
    }
    dispatchInsert(parts.join(''));
  };

  /** AIGC：场景化 Agent 生成，scene 按分组映射；media scope 传 novel_id=0 由 agent-client 处理语义 */
  const handleAIGC = async () => {
    if (aigcLoading) return;
    setAigcLoading(true);
    try {
      const instruction = [
        `条目：${name.trim() || '（未命名）'}`,
        ...cfg.fields.map((f) => {
          const v = (fields[f.key] ?? '').trim();
          return v ? `${f.label}：${v}` : '';
        }),
      ]
        .filter(Boolean)
        .join('\n');
      const res = await agentGenerate({
        novel_id: scope === 'novel' ? (novelId ?? 0) : 0,
        scene: type,
        item_id: item?.id,
        instruction,
      });
      setAigcPreview(res.content);
    } catch {
      showToast('AIGC 生成失败，请稍后重试', 'error');
    } finally {
      setAigcLoading(false);
    }
  };

  /** 上传立绘：按 scope 调对应端点，成功后追加 portraits 草稿 */
  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadPortrait(scope, novelId, file);
      setPortraits((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          url: res.url,
          thumb_url: res.thumb_url,
          source: 'upload',
          created_at: new Date().toISOString(),
        },
      ]);
      showToast('立绘已上传', 'success');
    } catch {
      showToast('上传失败，请检查后端服务', 'error');
    } finally {
      setUploading(false);
    }
  };

  /** AI 生成立绘：外貌特征拼上下文 → /aigc/prompt → /aigc/generate → 轮询任务结果 */
  const handleAiPortrait = async () => {
    if (aiPortraitLoading) return;
    setAiPortraitLoading(true);
    try {
      const appearance =
        (fields['appearance'] ?? '').trim() || (fields['brief'] ?? '').trim() || name.trim();
      const contextText = `角色立绘：${name.trim() || '未命名'}。外貌特征：${appearance}`;
      const res = await generatePortraitImage(contextText, scope === 'novel' ? (novelId ?? 0) : 0);
      setPortraits((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          url: res.url,
          thumb_url: res.thumb_url,
          source: 'ai',
          created_at: new Date().toISOString(),
        },
      ]);
      showToast('AI 立绘已生成', 'success');
    } catch {
      showToast('AI 绘图服务暂不可用', 'error');
    } finally {
      setAiPortraitLoading(false);
    }
  };

  const removePortrait = (id: string) => setPortraits((prev) => prev.filter((p) => p.id !== id));

  const updateRelation = (id: string, patch: Partial<MemoryRelation>) =>
    setRelations((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== ''));
      const cleanRelations = relations
        .filter((r) => r.target_name.trim() !== '')
        .map((r) => ({ ...r, target_name: r.target_name.trim(), relation: r.relation.trim() }));
      const payload: MemoryEditorPayload = {
        type,
        name: name.trim(),
        content,
        tags: parseTags(tagsRaw),
        pinned,
        fields: cleanFields,
        ai_visible: aiVisible,
        relations: cleanRelations,
        portraits,
      };
      if (showVisibility) {
        // 限制可见性关闭 → 空数组 = 全部章节可见；开启 → 提交所选（过滤已失效 id）
        payload.visible_chapters = limitVisible
          ? [...visibleChapters].filter((id) => allNodeIds.has(id))
          : [];
      }
      await onSubmit(payload);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const editorHeight = fullscreen ? 'h-[76vh]' : editorFocused ? 'h-[62vh]' : 'h-[300px]';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="640px"
      title={item?.name || '新建记忆条目'}
      minimizable
      minimized={minimized}
      onMinimize={onMinimize}
      maximizable
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
    >
      <div className="px-5 py-4 flex flex-col gap-3">
        {/* Tab 栏：按分组声明渲染；局部专注时隐藏 */}
        {!editorFocused && (
          <div className="flex items-center gap-1 border-b border-white/8 pb-2">
            {cfg.tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded-md text-xs transition-colors ${
                  tab === t
                    ? 'bg-brand-600/25 text-brand-300'
                    : 'text-neutral-500 hover:text-neutral-200 hover:bg-white/8'
                }`}
              >
                {MEMORY_TAB_META[t].label}
              </button>
            ))}
          </div>
        )}

        {/* ── 基本资料 Tab ─────────────────────────────────────── */}
        {tab === 'profile' && !editorFocused && (
          <div className="flex flex-col gap-3">
            {/* 分组切换（编辑已有条目时分组只读） */}
            <div className="flex items-center gap-2 flex-wrap">
              {GROUP_ORDER.map((t) => {
                const g = GROUP_CONFIG[t];
                const Icon = g.icon;
                return (
                  <button
                    key={t}
                    onClick={() => handleTypeChange(t)}
                    disabled={!!item}
                    title={item ? '编辑已有条目时不可切换分组' : undefined}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                      type === t
                        ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                        : 'bg-white/5 text-neutral-400 border-white/8 hover:bg-white/10'
                    } disabled:cursor-not-allowed disabled:opacity-80`}
                  >
                    <Icon size={12} className={type === t ? g.color : undefined} />
                    {g.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-neutral-600 -mt-1.5">{cfg.description}</p>

            {/* 标题 */}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名称（如：林晚 / 北境雪城 / 写打斗戏的 tip）"
              className={inputCls}
              autoFocus
            />

            {/* 结构化引导字段：思路引导用，允许留空 */}
            {cfg.fields.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {cfg.fields.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1">
                    <span className="text-[11px] text-neutral-500">{f.label}</span>
                    <input
                      value={fields[f.key] ?? ''}
                      onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full rounded-lg bg-white/4 border border-white/8 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
                    />
                  </label>
                ))}
              </div>
            )}

            {/* 标签 */}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-neutral-500">标签（# 分隔，可选）</span>
              <input
                value={tagsRaw}
                onChange={(e) => setTagsRaw(e.target.value)}
                placeholder="如：#主角 #反派 #关键道具"
                className={inputCls}
              />
            </label>

            {/* 开关区 */}
            <div className="flex items-center gap-5 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                <Switch checked={pinned} onChange={setPinned} />
                置顶（排最前，AI 优先携带）
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                <Switch checked={aiVisible} onChange={setAiVisible} />
                AI 可见（注入上下文）
              </label>
            </div>

            {/* 限制可见性：仅 novel scope */}
            {showVisibility && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-white/8 bg-white/3 p-3">
                <label className="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                  <Switch checked={limitVisible} onChange={setLimitVisible} />
                  限制 AI 可见性（章节解锁后才注入上下文）
                </label>
                {limitVisible && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-neutral-500">
                        所选章节任一完成后对 AI 解锁（不选 = 始终不可见）
                      </span>
                      {visibleChapters.size > 0 && (
                        <button
                          onClick={() => setVisibleChapters(new Set())}
                          className="text-[10px] text-neutral-600 hover:text-neutral-300 transition-colors"
                        >
                          清空选择
                        </button>
                      )}
                    </div>
                    {!hasOutline ? (
                      <p className="text-[11px] text-neutral-600 leading-relaxed">
                        该作品暂无章节大纲。之后可在大纲建好后回来收窄范围。
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2 max-h-[140px] overflow-y-auto pr-1">
                        {acts
                          .filter((a) => a.nodes.length > 0)
                          .map((act) => (
                            <div key={act.id}>
                              <div className="text-[10px] text-neutral-600 mb-1">{act.title}</div>
                              <div className="flex flex-wrap gap-1">
                                {act.nodes.map((node) => {
                                  const active = visibleChapters.has(node.id);
                                  return (
                                    <button
                                      key={node.id}
                                      onClick={() => toggleNode(node.id)}
                                      className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                                        active
                                          ? 'bg-brand-600/25 text-brand-300 border-brand-500/40'
                                          : 'bg-white/5 text-neutral-500 border-white/8 hover:text-neutral-300'
                                      }`}
                                    >
                                      {node.title || '未命名节点'}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                    {staleIds.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-white/6">
                        <AlertTriangle size={11} className="text-amber-400" />
                        {staleIds.map((id) => (
                          <button
                            key={id}
                            onClick={() => toggleNode(id)}
                            title="点击清除该失效关联"
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors line-through"
                          >
                            已失效
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 人物关系 Tab ─────────────────────────────────────── */}
        {tab === 'relations' && !editorFocused && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-neutral-500">
                与其他条目或角色的关系（随保存一起提交）
              </span>
              <button
                onClick={() =>
                  setRelations((prev) => [
                    ...prev,
                    { id: crypto.randomUUID(), target_name: '', relation: '', bond: 50 },
                  ])
                }
                className={ghostBtnCls}
              >
                <Plus size={12} />
                添加关系
              </button>
            </div>
            {relations.length === 0 ? (
              <p className="text-[11px] text-neutral-600 rounded-lg border border-dashed border-white/10 p-4 text-center">
                暂无关系条目，点击「添加关系」开始梳理人物网络
              </p>
            ) : (
              relations.map((r) => (
                <RelationRow
                  key={r.id}
                  relation={r}
                  candidates={relationCandidates}
                  onChange={(patch) => updateRelation(r.id, patch)}
                  onRemove={() => setRelations((prev) => prev.filter((x) => x.id !== r.id))}
                />
              ))
            )}
          </div>
        )}

        {/* ── 详情 Tab：TipTap plain 编辑区 + AIGC + 局部专注 ─── */}
        {tab === 'detail' && (
          <div className="flex flex-col gap-1.5">
            {!editorFocused && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-neutral-500">正文</span>
                <button onClick={loadFieldsToEditor} className={ghostBtnCls} title="把非空的引导字段插入到光标处">
                  <Plus size={12} />
                  一键加载基本资料
                </button>
              </div>
            )}
            <div
              className={`rounded-lg border border-white/10 bg-white/4 overflow-hidden flex flex-col ${editorHeight}`}
            >
              <TipTapEditor
                content={content}
                onChange={setContent}
                variant={scope === 'media' ? 'media' : 'memo'}
                toolbarPreset="plain"
                placeholder={cfg.placeholder}
                editorClassName="prose prose-invert prose-sm max-w-none min-h-[120px] px-3 py-2 text-neutral-200 focus:outline-none"
                focusable
                focused={editorFocused}
                onToggleFocus={() => setEditorFocused((v) => !v)}
                onAIGC={handleAIGC}
                aigcLoading={aigcLoading}
                insertTarget={instanceKey}
              />
            </div>
          </div>
        )}

        {/* ── 立绘 Tab：图片墙 + 上传 + AI 生成 ────────────────── */}
        {tab === 'portrait' && !editorFocused && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => fileRef.current?.click()} disabled={uploading} className={ghostBtnCls}>
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {uploading ? '上传中…' : '上传立绘'}
              </button>
              <button onClick={handleAiPortrait} disabled={aiPortraitLoading} className={ghostBtnCls}>
                {aiPortraitLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} className="text-fuchsia-300" />
                )}
                {aiPortraitLoading ? '生成中…' : 'AI 生成立绘'}
              </button>
              <span className="text-[10px] text-neutral-600">
                AI 生成基于「外貌特征」字段自动拼 Prompt
              </span>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFilePick} />
            </div>
            {portraits.length === 0 ? (
              <p className="text-[11px] text-neutral-600 rounded-lg border border-dashed border-white/10 p-6 text-center">
                暂无立绘，可上传图片或用 AI 生成
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {portraits.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => setPreviewPortrait(p)}
                    className="group relative rounded-lg overflow-hidden border border-white/8 bg-white/4 cursor-pointer hover:border-brand-500/50 transition-colors"
                    title="点击查看原图"
                  >
                    <img
                      src={p.thumb_url}
                      alt={name || '立绘'}
                      loading="lazy"
                      className="w-full aspect-[3/4] object-cover"
                    />
                    {p.source === 'ai' && (
                      <span className="absolute left-1 bottom-1 flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-md bg-black/55 text-fuchsia-300 backdrop-blur">
                        <Sparkles size={9} />
                        AI
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removePortrait(p.id);
                      }}
                      title="移除该立绘引用（不删除服务器文件）"
                      className="absolute top-1 right-1 p-1 rounded-md bg-black/55 text-neutral-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 底部按钮：局部专注时隐藏 */}
        {!editorFocused && (
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={!name.trim() || saving}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-lg shadow-brand-600/20"
            >
              {saving ? '保存中…' : item ? '保存修改' : '保存条目'}
            </button>
          </div>
        )}
      </div>

      {/* AIGC 结果预览：插入到光标 / 放弃 */}
      <Modal
        open={aigcPreview !== null}
        onClose={() => setAigcPreview(null)}
        title="AIGC 生成结果"
        width="520px"
      >
        <div className="px-5 py-4 flex flex-col gap-3">
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-white/8 bg-white/3 p-3 text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
            {aigcPreview}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setAigcPreview(null)}
              className="px-4 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-white/8 transition-colors"
            >
              放弃
            </button>
            <button
              onClick={() => {
                if (aigcPreview) dispatchInsert(`<p>${escapeHtml(aigcPreview).replace(/\n/g, '</p><p>')}</p>`);
                setAigcPreview(null);
              }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-brand-600 to-fuchsia-600 hover:from-brand-500 hover:to-fuchsia-500 text-white transition-all shadow-lg shadow-brand-600/20"
            >
              插入到光标
            </button>
          </div>
        </div>
      </Modal>

      {/* 立绘原图预览 */}
      <Modal
        open={previewPortrait !== null}
        onClose={() => setPreviewPortrait(null)}
        title="立绘预览"
        width="480px"
      >
        {previewPortrait && (
          <div className="px-5 py-4">
            <img
              src={previewPortrait.url}
              alt={name || '立绘原图'}
              className="w-full max-h-[70vh] object-contain rounded-lg border border-white/8"
            />
          </div>
        )}
      </Modal>
    </Modal>
  );
};

export default MemoryEditorModal;
