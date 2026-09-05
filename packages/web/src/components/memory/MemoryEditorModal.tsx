import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import Modal from '@/components/common/Modal';
import TipTapEditor from '@/components/editor/TipTapEditor';
import AigcCard from '@/components/ai/AigcCard';
import { useToast } from '@/components/common/Toast';
import { GROUP_CONFIG, GROUP_ORDER, MEMORY_TAB_META, type MemoryTab } from './memory-config';
import { parseTags, formatTags } from '@/utils/tags';
import { escapeHtml } from '@/utils/html';
import { useOutlineStore, type OutlineAct } from '@/stores/outline-store';
import {
  normalizeAccess,
  type MemoryAccess,
  type MemoryAccessMode,
  type MemoryItem,
  type MemoryPortrait,
  type MemoryRelation,
  type MemoryType,
} from '@/stores/memory-store';
import { uploadPortrait } from '@/services/agent-client';

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

/** 内容组件 props：不含 Modal 外壳（modal=弹窗外壳内嵌；tab=中央标签页直渲） */
interface MemoryEditorContentProps {
  scope: 'novel' | 'media';
  novelId?: number;
  item: MemoryItem | null;
  defaultType?: MemoryType;
  onSubmit: (payload: MemoryEditorPayload) => Promise<void>;
  onClose: () => void;
  allItems: MemoryItem[];
  instanceKey: string;
  variant?: 'modal' | 'tab';
  /** modal 外壳的全屏态（tab 场景忽略） */
  fullscreen?: boolean;
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

/** 权限模式选项行（单选语义；软闸/硬闸分组渲染） */
const AccessGateOption: React.FC<{
  active: boolean;
  label: string;
  desc: string;
  onClick: () => void;
}> = ({ active, label, desc, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
      active ? 'bg-brand-600/20 border-brand-500/40' : 'bg-white/4 border-white/8 hover:bg-white/8'
    }`}
  >
    <span
      className={`mt-0.5 w-3 h-3 rounded-full border shrink-0 flex items-center justify-center ${
        active ? 'border-brand-400' : 'border-neutral-600'
      }`}
    >
      {active && <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />}
    </span>
    <span className="flex flex-col min-w-0">
      <span className={`text-[11px] ${active ? 'text-brand-200' : 'text-neutral-300'}`}>{label}</span>
      <span className="text-[10px] text-neutral-600 leading-relaxed">{desc}</span>
    </span>
  </button>
);

/**
 * 记忆条目编辑器内容（四 Tab：基本资料 / 人物关系 / 详情 / 立绘，按分组声明渲染）：
 * 详情 Tab 内置 AIGC（agent/generate）预览插入与「一键加载基本资料」；
 * 立绘 Tab 支持上传与 AI 生成（复用 /aigc/prompt + /aigc/generate 链路）。
 * variant="tab" 时作为中央标签页内容直渲（无 Modal 外壳）。
 */
const MemoryEditorContent: React.FC<MemoryEditorContentProps> = ({
  scope,
  novelId,
  item,
  defaultType = 'character',
  onSubmit,
  onClose,
  allItems,
  instanceKey,
  variant = 'modal',
  fullscreen = false,
}) => {
  const { showToast } = useToast();
  const [tab, setTab] = useState<MemoryTab>('profile');
  const [type, setType] = useState<MemoryType>(defaultType);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tagsRaw, setTagsRaw] = useState('');
  const [pinned, setPinned] = useState(false);
  /** AI 访问闸门（3 软闸 + 3 硬闸），'default' = 全部关闭；仅 novel scope 显示 */
  const [accessMode, setAccessMode] = useState<MemoryAccessMode | 'default'>('default');
  /** restricted_*：解锁章（单选，大纲节点 id） */
  const [unlockId, setUnlockId] = useState('');
  /** partial_*：章节集合（多选，大纲节点 id） */
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [portraits, setPortraits] = useState<MemoryPortrait[]>([]);
  const [editorFocused, setEditorFocused] = useState(false);
  const [aigcPreview, setAigcPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewPortrait, setPreviewPortrait] = useState<MemoryPortrait | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadOutline = useOutlineStore((s) => s.loadOutline);
  const acts = useOutlineStore((s) => (novelId !== undefined ? s.byNovel[novelId] : undefined)) ?? NO_ACTS;

  // 挂载时初始化表单（Modal 复用时由 key 重挂触发重置；tab 场景每实例独立）
  useEffect(() => {
    setTab('profile');
    setType(item?.type ?? defaultType);
    setName(item?.name ?? '');
    setContent(item?.content ?? '');
    setFields({ ...(item?.fields ?? {}) });
    setTagsRaw(formatTags(item?.tags ?? []));
    setPinned(!!item?.pinned);
    // 旧字段（ai_visible / visible_chapters）经 normalizeAccess 迁移后读取
    const acc = item ? normalizeAccess(item) : undefined;
    setAccessMode(acc?.mode ?? 'default');
    setUnlockId(acc?.unlock_chapter_id ?? '');
    setVisibleIds(new Set(acc?.visible_chapter_ids ?? []));
    setRelations((item?.relations ?? []).map((r) => ({ ...r })));
    setPortraits((item?.portraits ?? []).map((p) => ({ ...p })));
    setEditorFocused(false);
    setAigcPreview(null);
    setPreviewPortrait(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // novel scope：挂载时拉取大纲供"限制可见性"候选
  useEffect(() => {
    if (scope === 'novel' && novelId !== undefined) void loadOutline(novelId);
  }, [scope, novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = GROUP_CONFIG[type];
  const showVisibility = scope === 'novel' && novelId !== undefined;

  const allNodeIds = useMemo(() => new Set(acts.flatMap((a) => a.nodes.map((n) => n.id))), [acts]);
  /** 已选但不在当前大纲中的节点 id（解锁章 + 可见章集合合并展示） */
  const staleIds = useMemo(() => {
    const picked = [unlockId, ...visibleIds].filter((id) => id && !allNodeIds.has(id));
    return [...new Set(picked)];
  }, [unlockId, visibleIds, allNodeIds]);
  const hasOutline = acts.some((a) => a.nodes.length > 0);

  /** 当前模式是否需要单选解锁章 / 多选章节集合 */
  const needUnlock = accessMode.startsWith('restricted_');
  const needVisibleSet = accessMode.startsWith('partial_');

  const toggleVisibleNode = (nodeId: string) =>
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });

  /** 关系目标候选：同库其他条目 */
  const relationCandidates = useMemo(
    () => allItems.filter((i) => i.id !== item?.id),
    [allItems, item?.id],
  );

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

  /** AIGC 公共上下文：条目名 + 已填引导字段（各卡 buildInstruction 复用） */
  const aigcContext = () =>
    [
      `条目：${name.trim() || '（未命名）'}`,
      ...cfg.fields.map((f) => {
        const v = (fields[f.key] ?? '').trim();
        return v ? `${f.label}：${v}` : '';
      }),
    ]
      .filter(Boolean)
      .join('\n');

  /** 详情正文纯文本摘录（表单 ↔ 详情相互拉取：表单卡参考详情，详情卡参考表单已含 aigcContext） */
  const detailExcerpt = () => {
    const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 600) : '';
  };

  /** 表单卡产物 → 引导字段：识别「字段名：内容」行回填；识别失败则退入详情预览 */
  const applyFieldsFromAI = (text: string) => {
    const byLabel = new Map(cfg.fields.map((f) => [f.label, f.key]));
    const next = { ...fields };
    let hit = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim().replace(/^[-*•\d.、\s]+/, '');
      const m = line.match(/^([^：:]{1,12})[：:](.+)$/);
      if (!m) continue;
      const key = byLabel.get(m[1].trim());
      if (key && m[2].trim()) {
        next[key] = m[2].trim();
        hit += 1;
      }
    }
    if (hit === 0) {
      setAigcPreview(text);
      showToast('未能识别出「字段名：内容」行，已放入详情预览', 'info');
      return;
    }
    setFields(next);
    showToast(`已填入 ${hit} 项基本资料`, 'success');
  };

  /** 关系卡产物 → 关系行：识别「目标 | 关系 | 备注」行追加 */
  const applyRelationsFromAI = (text: string) => {
    const rows = text
      .split('\n')
      .map((l) => l.trim().replace(/^[-*•\d.、\s]+/, ''))
      .filter(Boolean)
      .map((line) => line.split(/[|｜]/).map((s) => s.trim().replace(/^["「『]|["」』]$/g, '')))
      .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
      .map((parts) => ({
        id: crypto.randomUUID(),
        target_name: parts[0],
        relation: parts[1],
        bond: 50,
        note: parts[2] || undefined,
      }));
    if (rows.length === 0) {
      showToast('未能识别关系（需「目标 | 关系 | 备注」逐行输出）', 'error');
      return;
    }
    setRelations((prev) => [...prev, ...rows]);
    showToast(`已添加 ${rows.length} 条关系`, 'success');
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

  /** 立绘卡产物 → 追加 AI 立绘引用（thumb 缺省用原图） */
  const applyPortraitFromAI = (url: string) => {
    setPortraits((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        url,
        thumb_url: url,
        source: 'ai',
        created_at: new Date().toISOString(),
      },
    ]);
    showToast('AI 立绘已生成', 'success');
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
        relations: cleanRelations,
        portraits,
      };
      // AI 访问闸门（novel scope）：模式 + 章节参数；过滤已失效节点 id。
      // 旧字段（ai_visible / visible_chapters）自此不再写入。
      if (showVisibility || scope === 'media') {
        if (accessMode !== 'default') {
          const acc: MemoryAccess = { mode: accessMode };
          if (accessMode.startsWith('restricted_')) {
            if (unlockId && allNodeIds.has(unlockId)) acc.unlock_chapter_id = unlockId;
          } else if (accessMode.startsWith('partial_')) {
            acc.visible_chapter_ids = [...visibleIds].filter((id) => allNodeIds.has(id));
          }
          payload.ai_access = acc;
        }
      }
      await onSubmit(payload);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const editorHeight =
    variant === 'tab'
      ? editorFocused
        ? 'h-[70vh]'
        : 'h-[52vh]'
      : fullscreen
        ? 'h-[76vh]'
        : editorFocused
          ? 'h-[62vh]'
          : 'h-[300px]';

  return (
    <>
      <div
        className={`${
          variant === 'tab' ? 'px-6 py-4 h-full overflow-y-auto' : 'px-5 py-4'
        } flex flex-col gap-3`}
      >
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

            {/* AIGC 配置卡（备忘录 L61）：表单 ↔ 详情相互拉取，产物按「字段名：内容」回填表单 */}
            <AigcCard
              novelId={scope === 'novel' ? (novelId ?? 0) : 0}
              scene={type}
              itemId={item?.id}
              taskLabel={`AIGC · 填写${cfg.label}`}
              hint="AI 补全引导字段（输出「字段名：内容」自动回填表单），并参考详情正文"
              buildInstruction={(extra) =>
                [
                  aigcContext(),
                  detailExcerpt() ? `详情正文（供参考拉取信息）：${detailExcerpt()}` : '',
                  `请补全以上引导字段，逐行输出「字段名：内容」格式（字段名必须取自：${cfg.fields.map((f) => f.label).join('、')}），不要输出其他内容。`,
                  extra ? `附加要求：${extra}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              }
              onApply={applyFieldsFromAI}
            />

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
            </div>

            {/* AI 访问权限：3 软闸 + 3 硬闸，默认全部关闭（备忘录）。 */}
            {(showVisibility || scope === 'media') && (
              <div className="flex flex-col gap-2 rounded-lg border border-white/8 bg-white/3 p-3">
                <span className="text-[11px] text-neutral-500">AI 访问权限（六种闸门默认关闭，单选）</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <AccessGateOption
                    active={accessMode === 'default'}
                    label="不限制（默认）"
                    desc="AI 正常读取本条目"
                    onClick={() => setAccessMode('default')}
                  />
                  <AccessGateOption
                    active={accessMode === 'ignore'}
                    label="AI 全局忽略"
                    desc="软闸：注入但要求忽略，除非指令明确提及"
                    onClick={() => setAccessMode('ignore')}
                  />
                  {showVisibility && (
                    <AccessGateOption
                      active={accessMode === 'restricted_visible'}
                      label="AI 限制可见"
                      desc="软闸：选 1 章解锁；此前不可剧透，仅可伏笔铺垫"
                      onClick={() => setAccessMode('restricted_visible')}
                    />
                  )}
                  {showVisibility && (
                    <AccessGateOption
                      active={accessMode === 'partial_visible'}
                      label="AI 局部可见"
                      desc="软闸：多选可见章；其余不可剧透，仅可伏笔铺垫"
                      onClick={() => setAccessMode('partial_visible')}
                    />
                  )}
                  <AccessGateOption
                    active={accessMode === 'disabled'}
                    label="AI 全局禁用"
                    desc="硬闸：任何情况都不注入本条目"
                    onClick={() => setAccessMode('disabled')}
                  />
                  {showVisibility && (
                    <AccessGateOption
                      active={accessMode === 'restricted_disabled'}
                      label="AI 限制禁用"
                      desc="硬闸：选 1 章，该章及以后才注入"
                      onClick={() => setAccessMode('restricted_disabled')}
                    />
                  )}
                  {showVisibility && (
                    <AccessGateOption
                      active={accessMode === 'partial_disabled'}
                      label="AI 局部禁用"
                      desc="硬闸：仅选中章注入，其余不注入"
                      onClick={() => setAccessMode('partial_disabled')}
                    />
                  )}
                </div>

                {/* 章节选择：restricted_* 单选解锁章；partial_* 多选可见章 */}
                {showVisibility && (needUnlock || needVisibleSet) && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-neutral-500">
                        {needUnlock
                          ? accessMode.endsWith('_visible')
                            ? '选择解锁章：该章及以后对 AI 可见；此前视为不可见，仅可伏笔/隐晦线索'
                            : '选择解锁章：该章及以后才注入；此前不注入'
                          : accessMode.endsWith('_visible')
                            ? '勾选可见章：仅这些章节可见；其余仅可伏笔/隐晦线索'
                            : '勾选注入章：仅这些章节注入'}
                        （不选 = 始终受限）
                      </span>
                      {needVisibleSet && visibleIds.size > 0 && (
                        <button
                          onClick={() => setVisibleIds(new Set())}
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
                                  const active = needUnlock ? unlockId === node.id : visibleIds.has(node.id);
                                  return (
                                    <button
                                      key={node.id}
                                      onClick={() =>
                                        needUnlock
                                          ? setUnlockId(unlockId === node.id ? '' : node.id)
                                          : toggleVisibleNode(node.id)
                                      }
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
                            onClick={() => {
                              if (id === unlockId) setUnlockId('');
                              else setVisibleIds((prev) => new Set([...prev].filter((x) => x !== id)));
                            }}
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
            {/* AIGC 配置卡：基于条目与同库条目生成关系网，逐行「目标 | 关系 | 备注」自动追加 */}
            <AigcCard
              novelId={scope === 'novel' ? (novelId ?? 0) : 0}
              scene="character"
              itemId={item?.id}
              taskLabel="AIGC · 梳理人物关系"
              hint="AI 生成关系网（逐行「目标 | 关系 | 备注」自动追加为关系条目）"
              buildInstruction={(extra) =>
                [
                  aigcContext(),
                  relations.length
                    ? `已有关系：${relations.map((r) => `${r.target_name}（${r.relation}）`).join('；')}`
                    : '',
                  `同库其他条目：${relationCandidates.map((c) => c.name).join('、') || '（无）'}`,
                  '请生成人物关系，逐行输出「目标 | 关系 | 备注（可空）」格式，不要输出其他内容。',
                  extra ? `附加要求：${extra}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              }
              onApply={applyRelationsFromAI}
            />
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
                insertTarget={instanceKey}
                aigcSlot={
                  /* AIGC 配置卡（备忘录 L61）：基于基本资料生成详情正文，预览后插入光标处 */
                  <AigcCard
                    novelId={scope === 'novel' ? (novelId ?? 0) : 0}
                    scene={type}
                    itemId={item?.id}
                    taskLabel={`AIGC · ${cfg.label}详情`}
                    hint="基于基本资料与线索库生成详情正文，预览后插入"
                    buildInstruction={(extra) =>
                      `${aigcContext()}${extra ? `\n附加要求：${extra}` : ''}`
                    }
                    onApply={(c) => setAigcPreview(c)}
                  />
                }
              />
            </div>
          </div>
        )}

        {/* ── 立绘 Tab：AIGC 配置卡（图片工作流） + 上传 + 图片墙 ─ */}
        {tab === 'portrait' && !editorFocused && (
          <div className="flex flex-col gap-3">
            <AigcCard
              novelId={scope === 'novel' ? (novelId ?? 0) : 0}
              scene="character"
              taskLabel="AIGC · 立绘"
              hint="基于「外貌特征」字段自动拼 Prompt 生成角色立绘"
              mode="image"
              buildInstruction={(extra) => {
                const appearance =
                  (fields['appearance'] ?? '').trim() ||
                  (fields['brief'] ?? '').trim() ||
                  name.trim();
                return `角色立绘：${name.trim() || '未命名'}。外貌特征：${appearance}${extra ? `。${extra}` : ''}`;
              }}
              onApply={applyPortraitFromAI}
            />
            <div className="flex items-center gap-2">
              <button onClick={() => fileRef.current?.click()} disabled={uploading} className={ghostBtnCls}>
                {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {uploading ? '上传中…' : '上传立绘'}
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
      </>
  );
};

/** Modal 外壳包装：自媒体全局记忆等多窗口场景仍以弹窗形态使用（novel 主链路已改中央标签页） */
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
      <MemoryEditorContent
        key={open ? 'open' : 'closed'}
        scope={scope}
        novelId={novelId}
        item={item}
        defaultType={defaultType}
        onSubmit={onSubmit}
        onClose={onClose}
        allItems={allItems}
        instanceKey={instanceKey}
        variant="modal"
      />
    </Modal>
  );
};

export default MemoryEditorModal;
export { MemoryEditorContent };
