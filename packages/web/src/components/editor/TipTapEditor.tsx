import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Toolbar from './Toolbar';
import ChapterBreak from './extensions/ChapterBreak';
import CharacterMention, { CharacterSuggestionPopup } from './extensions/CharacterMention';
import ContextMenu from './ContextMenu';
import DiffViewer from './DiffViewer';
import SlashCommandMenu, { SLASH_ITEMS, type SlashItem } from './SlashCommandMenu';
import ImagePickerModal from './ImagePickerModal';
import CandidatesPanel, { setLastCandidatesContext } from './CandidatesPanel';
import { toast } from '@/components/common/Toast';
import { uploadImage } from '@/services/image-client';
import { putAutoSnapshot } from '@/utils/temp-branch';
import { track } from '@/services/analytics';
import { useAIStore } from '@/stores/ai-store';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore } from '@/stores/ui-store';
import { useCandidatesStore } from '@/stores/candidates-store';
import type { MediaPlatform } from '@/types/media';

interface TipTapEditorProps {
  content: string;
  onChange: (html: string) => void;
  onWordCount?: (count: number) => void;
  /** 编辑器变体：novel 含角色@提及/章节分隔/行内续写等小说专属能力 */
  variant?: EditorVariant;
  placeholder?: string;
  /** 自媒体模式：当前发布平台（统一导出弹窗内选择） */
  platform?: MediaPlatform;
  onSelectPlatform?: (id: MediaPlatform) => void;
  /** 自媒体模式：平台风格改写入口 */
  onAdapt?: () => Promise<void>;
  /** 工具栏预设：plain 时仅保留纯文本格式化按钮，并 gate 掉 AI/小说专属交互（弹窗编辑器场景） */
  toolbarPreset?: 'full' | 'plain';
  /** 编辑区内容层类名（覆盖默认 prose 基线，弹窗场景可传小 min-h） */
  editorClassName?: string;
  /** 局部专注：是否提供受控专注开关（由宿主决定布局） */
  focusable?: boolean;
  /** 局部专注：当前是否处于专注态（受控） */
  focused?: boolean;
  /** 局部专注：切换回调（受控） */
  onToggleFocus?: () => void;
  /** 编辑器实例标识：写入容器 data-inkbloom-editor，供 inkbloom:insert-content 定向投递 */
  insertTarget?: string;
  /** 工具栏下方插槽（如章节标题输入框），由宿主自绘 */
  titleSlot?: React.ReactNode;
  /** AIGC 配置卡片插槽（备忘录 L61）：渲染在工具列表最上方，所有富文本编辑器统一 */
  aigcSlot?: React.ReactNode;
}

/** 编辑器变体：三种创作模式共用同一套富文本内核 */
export type EditorVariant = 'novel' | 'media' | 'memo';

interface SuggestionState {
  visible: boolean;
  rect: DOMRect | null;
  query: string;
}

interface CtxMenuState {
  position: { x: number; y: number } | null;
  selectedText: string;
}

interface SlashState {
  visible: boolean;
  rect: DOMRect | null;
  query: string;
}

/** 模块级：最近一次获得焦点的编辑器容器（insert-content 无 target 时的定向依据） */
let lastActiveEditorEl: HTMLDivElement | null = null;

const TipTapEditor: React.FC<TipTapEditorProps> = ({
  content,
  onChange,
  onWordCount,
  variant = 'novel',
  placeholder,
  platform,
  onSelectPlatform,
  onAdapt,
  toolbarPreset = 'full',
  editorClassName,
  focusable,
  focused,
  onToggleFocus,
  insertTarget,
  titleSlot,
  aigcSlot,
}) => {
  const isNovel = variant === 'novel';
  const isPlain = toolbarPreset === 'plain';
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const rawFocusMode = useUIStore((s) => s.focusMode);
  // plain 模式隔离全局专注态：弹窗编辑器不参与主界面专注模式
  const focusMode = isPlain ? false : rawFocusMode;
  const triggerInline = useAIStore((s) => s.triggerInline);
  const inlineSuggestion = useAIStore((s) => s.inlineSuggestion);
  const isInlineStreaming = useAIStore((s) => s.isInlineStreaming);
  const clearInlineSuggestion = useAIStore((s) => s.clearInlineSuggestion);
  const rewriteResult = useAIStore((s) => s.rewriteResult);
  const showDiffViewer = useAIStore((s) => s.showDiffViewer);
  const acceptRewrite = useAIStore((s) => s.acceptRewrite);
  const rejectRewrite = useAIStore((s) => s.rejectRewrite);

  const [suggestion, setSuggestion] = useState<SuggestionState>({ visible: false, rect: null, query: '' });
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>({ position: null, selectedText: '' });
  const [inlinePos, setInlinePos] = useState<DOMRect | null>(null);
  const [slash, setSlash] = useState<SlashState>({ visible: false, rect: null, query: '' });
  const [slashIndex, setSlashIndex] = useState(0);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  // paste/drop 上传链路：editorProps 闭包在创建时捕获，经 ref 取最新编辑器实例与变体
  const editorInstanceRef = useRef<Editor | null>(null);
  const variantRef = useRef<EditorVariant>(variant);
  variantRef.current = variant;

  // ── F2-7：HTML/字数同步节流 ──────────────────────────────────────────
  // getHTML + 两次全文正则是每次按键最贵的操作，节流为 300ms trailing；
  // 卸载 / 切 tab（重挂载）时 flush，保证草稿不滞后于最后一次输入。
  const HTML_SYNC_THROTTLE_MS = 300;
  const htmlSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWordCountRef = useRef(onWordCount);
  onWordCountRef.current = onWordCount;

  const flushHtmlSync = useCallback(() => {
    if (htmlSyncTimerRef.current) {
      clearTimeout(htmlSyncTimerRef.current);
      htmlSyncTimerRef.current = null;
    }
    const ed = editorInstanceRef.current;
    if (!ed || ed.isDestroyed) return;
    const html = ed.getHTML();
    onChangeRef.current(html);
    const text = ed.state.doc.textContent;
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    onWordCountRef.current?.(chineseChars + englishWords);
  }, []);

  const scheduleHtmlSync = useCallback(() => {
    if (htmlSyncTimerRef.current) clearTimeout(htmlSyncTimerRef.current);
    htmlSyncTimerRef.current = setTimeout(flushHtmlSync, HTML_SYNC_THROTTLE_MS);
  }, [flushHtmlSync]);

  // 重挂载（章节切换 re-key）前 flush 未落网的 HTML，再清节流器
  useEffect(
    () => () => {
      flushHtmlSync();
    },
    [flushHtmlSync],
  );

  /** 图片文件 → 图床上传 → 成功后在光标处插入（绝不插入无效 src 或 base64） */
  const uploadAndInsertImages = async (files: File[]) => {
    if (files.length === 0) return;
    const v = variantRef.current;
    const novelId = v === 'novel' ? useNovelStore.getState().currentNovel?.id : undefined;
    toast.show(`正在上传 ${files.length} 张图片…`, 'info');
    let ok = 0;
    for (const file of files) {
      try {
        const res = await uploadImage(file, { scope: v, novelId });
        const ed = editorInstanceRef.current;
        if (ed && !ed.isDestroyed) {
          ed.chain()
            .focus()
            .insertContent({ type: 'image', attrs: { src: res.url, alt: res.display_name } })
            .run();
        }
        ok += 1;
      } catch (e) {
        toast.show(`${file.name}：${e instanceof Error ? e.message : '上传失败'}`, 'error');
      }
    }
    if (ok > 0) toast.show(`已插入 ${ok} 张图片`, 'success');
  };

  // Characters for mention suggestion popup
  const characters: Array<{ name: string; id: number }> = (currentNovel as any)?.characters ?? [];

  const editor = useEditor({
    // F2-7：输入不再触发 React 重渲染（宿主通过 onChange/refs 拿数据），
    // 万字长文的每次按键不再重绘整棵编辑器树
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      // inline 化：空段落插入独占一行视觉，文本中间插入行内嵌入；禁 base64
      Image.configure({ inline: true, allowBase64: false }),
      Placeholder.configure({
        placeholder: placeholder ?? '开始写作...',
      }),
      // 小说专属扩展：章节分隔与角色@提及（plain 模式不注册）
      ...(isNovel && !isPlain ? [ChapterBreak, CharacterMention] : []),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: content || '',
    onUpdate: ({ editor: ed }) => {
      // F2-7：getHTML + 全文正则统计是每次按键最贵的两步。HTML 走 300ms
      // trailing 节流（卸载/切 tab 时 flush）；字数用文档 size 增量近似，
      // 不再每次全文跑两遍正则。mention/slash 检测必须即时，保持原样。
      scheduleHtmlSync();

      // Check for @ mention trigger（仅小说模式，plain 禁用）
      const { state } = ed;
      const { $from } = state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0');
      if (isNovel && !isPlainRef.current) {
        const atMatch = textBefore.match(/@(\S*)$/);
        if (atMatch && characters.length > 0) {
          const coords = ed.view.coordsAtPos($from.pos);
          setSuggestion({
            visible: true,
            rect: new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top),
            query: atMatch[1],
          });
        } else {
          setSuggestion((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        }
      }

      // Check for / slash command trigger（行内独立斜杠开头，plain 模式禁用）
      const slashMatch = isPlainRef.current ? null : textBefore.match(/\/([\u4e00-\u9fff\w-]*)$/);
      const beforeSlash = textBefore.slice(0, textBefore.length - (slashMatch?.[0].length ?? 0));
      if (slashMatch && (beforeSlash === '' || /\s$/.test(beforeSlash))) {
        const coords = ed.view.coordsAtPos($from.pos);
        setSlash({
          visible: true,
          rect: new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top),
          query: slashMatch[1],
        });
        setSlashIndex(0);
      } else {
        setSlash((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      }
    },
    editorProps: {
      attributes: {
        class:
          editorClassName ??
          'prose prose-invert max-w-none min-h-[400px] px-8 py-6 focus:outline-none text-neutral-200',
      },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          // plain 模式禁用右键改写菜单
          if (isPlainRef.current) return false;
          const sel = view.state.selection;
          const { from, to } = sel;
          if (from === to) return false;
          const selectedText = view.state.doc.textBetween(from, to, ' ');
          if (!selectedText.trim()) return false;
          setCtxMenu({
            position: { x: event.clientX, y: event.clientY },
            selectedText,
          });
          event.preventDefault();
          return true;
        },
      },
      handlePaste: (_view, event) => {
        // plain（记忆弹窗编辑器）不参与图片上传链路
        if (isPlainRef.current) return false;
        // 图片文件粘贴 → 上传后插入（HTML/base64 粘贴走默认链路，base64 被扩展拒绝）
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void uploadAndInsertImages(files);
        return true;
      },
      handleDrop: (view, event) => {
        if (isPlainRef.current) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        // 拖入位置有文本节点时先移动光标到落点
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (pos) {
          const $pos = view.state.doc.resolve(Math.min(pos.pos, view.state.doc.content.size));
          view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
        }
        void uploadAndInsertImages(files);
        return true;
      },
      handleKeyDown: (view, event) => {
        // 斜杠命令菜单键盘导航
        if (slashMenuOpenRef.current) {
          const filtered = filteredSlashRef.current;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
            return true;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSlashIndex((i) => Math.max(i - 1, 0));
            return true;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const item = filtered[slashIndexRef.current];
            if (item) handleSlashSelectRef.current?.(item);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setSlash((prev) => ({ ...prev, visible: false }));
            return true;
          }
        }

        // Esc → 关闭多候选浮层
        if (event.key === 'Escape' && useCandidatesStore.getState().visible) {
          event.preventDefault();
          useCandidatesStore.getState().dismiss();
          return true;
        }

        // Ctrl+Space → inline completion（仅小说模式，plain 禁用）
        if (event.ctrlKey && event.code === 'Space' && isNovelRef.current && !isPlainRef.current) {
          event.preventDefault();
          const { state } = view;
          const { from } = state.selection;
          const docText = state.doc.textContent;

          const cursorPos = from;
          const preceding = docText.slice(Math.max(0, cursorPos - 500), cursorPos);
          const following = docText.slice(cursorPos, cursorPos + 500);

          const coords = view.coordsAtPos(from);
          setInlinePos(new DOMRect(coords.left, coords.bottom + 2, 0, 0));

          if (currentNovel && currentChapter) {
            triggerInline({
              novelId: currentNovel.id,
              chapterId: currentChapter.id,
              cursorPosition: cursorPos,
              precedingText: preceding,
              followingText: following,
            });
          }
          return true;
        }

        // Tab → accept inline suggestion
        if (event.key === 'Tab' && inlineSuggestion) {
          event.preventDefault();
          const { state, dispatch } = view;
          const tr = state.tr.insertText(inlineSuggestion, state.selection.from);
          dispatch(tr);
          clearInlineSuggestion();
          setInlinePos(null);
          return true;
        }

        // Esc → dismiss inline suggestion
        if (event.key === 'Escape' && inlineSuggestion) {
          event.preventDefault();
          clearInlineSuggestion();
          setInlinePos(null);
          return true;
        }

        // Esc → 退出专注模式（无建议时，plain 不参与）
        if (event.key === 'Escape' && !isPlainRef.current && useUIStore.getState().focusMode) {
          useUIStore.getState().exitFocusMode();
          return true;
        }

        return false;
      },
    },
  });

  editorInstanceRef.current = editor ?? null;

  // Sync external content changes
  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    if (currentHtml === content) return;
    if (content !== '') {
      editor.commands.setContent(content);
      // F2-1 双保险：外部换绑内容后清空撤销栈，杜绝「在 B 章 Ctrl+Z 倒回
      // A 章全文」——宿主已按 chapter-{id} re-key，此行防御未来 key 被移除
      // （旧版 TipTap 无 clearHistory 命令时静默跳过，re-key 兜底仍生效）
      (editor.commands as unknown as { clearHistory?: () => void }).clearHistory?.();
      return;
    }
    // 空内容同步：宿主传入 '' 但编辑器非空 —— 发生于按 id re-key 重挂载后宿主状态
    // 滞后一拍（首帧以上一条内容初始化）或外部清空，必须清空编辑器。
    // 仅按文本判空：用户删空全文时 onChange 已回写 ''，此时编辑器本就为空，不会触发。
    // setContent 第二参 emitUpdate 缺省为 false，不会触发 onUpdate，避免把空内容
    // 反向回写宿主、误触发防抖保存与字数统计。
    if (editor.state.doc.textContent.trim().length > 0) {
      editor.commands.setContent('');
      (editor.commands as unknown as { clearHistory?: () => void }).clearHistory?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor]);

  // 占位符动态更新（如自媒体模式切换平台后提示语变化）
  useEffect(() => {
    if (!editor || placeholder == null) return;
    const ext = editor.extensionManager.extensions.find((e) => e.name === 'placeholder');
    if (ext) {
      (ext.options as { placeholder: string }).placeholder = placeholder;
      // 触发一次空事务使占位符 decoration 重新计算
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, placeholder]);

  // Handle mention selection from popup
  const handleMentionSelect = useCallback(
    (attrs: { characterName: string; characterId: number }) => {
      if (!editor) return;
      const { state } = editor;
      const { $from } = state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0');
      const atMatch = textBefore.match(/@(\S*)$/);
      if (atMatch) {
        const deleteFrom = $from.pos - atMatch[0].length;
        editor.chain().focus()
          .deleteRange({ from: deleteFrom, to: $from.pos })
          .insertCharacterMention(attrs)
          .insertContent(' ')
          .run();
      } else {
        editor.chain().focus().insertCharacterMention(attrs).run();
      }
      setSuggestion((prev) => ({ ...prev, visible: false }));
    },
    [editor],
  );

  /**
   * AI 改写覆盖前暂存（备忘录 L61 三态）：当前正文压入浏览器临时分支，
   * 服务器不存第三份；用户可随时在版本管理面板撤销。
   */
  const snapshotBeforeAIRewrite = useCallback(() => {
    const chapterId = currentChapter?.id;
    if (!chapterId || !editor) return;
    putAutoSnapshot(chapterId, editor.getHTML(), 'AI 改写覆盖前');
  }, [currentChapter?.id, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle accepting rewrite: replace selected text in editor
  const handleAcceptRewrite = useCallback(async () => {
    if (!editor || !rewriteResult) return;
    // E1 (A04)：覆盖原文前存点，失败不阻断（提示见 snapshotBeforeAIRewrite）
    await snapshotBeforeAIRewrite();
    // 埋点：AI 改写被采纳（采纳率是 AI 价值的北极星指标，附录 B）
    track('ai_rewrite_accepted', {
      action: rewriteResult.action ?? 'unknown',
    });
    const { state } = editor;
    state.doc.nodesBetween(0, state.doc.content.size, (node, offset) => {
      if (node.isText && node.text?.includes(rewriteResult.original)) {
        const localIdx = node.text.indexOf(rewriteResult.original);
        const from = offset + localIdx;
        const to = from + rewriteResult.original.length;
        editor.chain().focus()
          .setTextSelection({ from, to })
          .insertContent(rewriteResult.modified)
          .run();
      }
    });
    acceptRewrite();
  }, [editor, rewriteResult, acceptRewrite, snapshotBeforeAIRewrite]);

  // Filter characters by query for mention popup
  const filteredChars = characters.filter(
    (c) => !suggestion.query || c.name.toLowerCase().includes(suggestion.query.toLowerCase()),
  );

  // ── 斜杠命令 ──────────────────────────────────────────────────────────
  const filteredSlash = SLASH_ITEMS.filter(
    (item) =>
      !slash.query ||
      item.title.toLowerCase().includes(slash.query.toLowerCase()) ||
      item.keywords.toLowerCase().includes(slash.query.toLowerCase()),
  );

  /** 执行斜杠命令：先删除 `/query` 触发文本，再执行对应动作 */
  const handleSlashSelect = useCallback(
    (item: SlashItem) => {
      if (!editor) return;
      const { state } = editor;
      const { $from } = state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0');
      const m = textBefore.match(/\/([\u4e00-\u9fff\w-]*)$/);
      if (m) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: $from.pos - m[0].length, to: $from.pos })
          .run();
      }
      setSlash((prev) => ({ ...prev, visible: false }));

      if (item.kind === 'image') {
        setImagePickerOpen(true);
        return;
      }

      if (item.kind === 'format') {
        const chain = editor.chain().focus();
        switch (item.format) {
          case 'h1': chain.toggleHeading({ level: 1 }).run(); break;
          case 'h2': chain.toggleHeading({ level: 2 }).run(); break;
          case 'h3': chain.toggleHeading({ level: 3 }).run(); break;
          case 'bullet': chain.toggleBulletList().run(); break;
          case 'ordered': chain.toggleOrderedList().run(); break;
          case 'quote': chain.toggleBlockquote().run(); break;
          case 'code': chain.toggleCodeBlock().run(); break;
          case 'hr': chain.setHorizontalRule().run(); break;
        }
        return;
      }

      // AI 动作 → 多候选生成（N 选 1）
      const docText = editor.state.doc.textContent;
      const cursor = editor.state.selection.from;
      const context = docText.slice(Math.max(0, cursor - 600), cursor);
      setLastCandidatesContext(context);
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      useCandidatesStore.getState().request(item.action, context, { left: coords.left, top: coords.bottom });
    },
    [editor],
  );

  // 供 handleKeyDown 闭包使用的最新值引用
  const isNovelRef = useRef(isNovel);
  isNovelRef.current = isNovel;
  const isPlainRef = useRef(isPlain);
  isPlainRef.current = isPlain;
  const slashMenuOpenRef = useRef(false);
  const filteredSlashRef = useRef<SlashItem[]>([]);
  const slashIndexRef = useRef(0);
  const handleSlashSelectRef = useRef<typeof handleSlashSelect>(handleSlashSelect);
  slashMenuOpenRef.current = slash.visible;
  filteredSlashRef.current = filteredSlash;
  slashIndexRef.current = slashIndex;
  handleSlashSelectRef.current = handleSlashSelect;

  /** 采纳候选：按行拆分插入为段落 */
  const handleAcceptCandidate = useCallback(
    async (text: string) => {
      if (!editor) return;
      await snapshotBeforeAIRewrite();
      track('ai_candidate_accepted', {});
      const nodes = text.split('\n').map((line) => ({
        type: 'paragraph',
        content: line.trim() ? [{ type: 'text', text: line }] : [],
      }));
      editor.chain().focus().insertContent(nodes).run();
    },
    [editor, snapshotBeforeAIRewrite],
  );

  // 定位跳转：AI 批注等外部面板通知编辑器选中指定文本
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text as string | undefined;
      if (!text || !editor) return;
      // 拼接纯文本并记录每个文本节点的文档位置
      const segments: { start: number; from: number; to: number }[] = [];
      let plain = '';
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          segments.push({ start: plain.length, from: pos, to: pos + node.text.length });
          plain += node.text;
        }
      });
      // 完整匹配失败时退而求其次匹配前 12 字
      let idx = plain.indexOf(text);
      let target = text;
      if (idx < 0 && text.length > 12) {
        target = text.slice(0, 12);
        idx = plain.indexOf(target);
      }
      if (idx < 0) return;
      const seg = segments.find((s) => idx >= s.start && idx < s.start + (s.to - s.from));
      if (!seg) return;
      const from = seg.from + (idx - seg.start);
      const to = Math.min(seg.to, from + target.length);
      editor.chain().focus().setTextSelection({ from, to }).run();
      editor.view.dispatch(editor.state.tr.scrollIntoView());
    };
    window.addEventListener('inkbloom:locate-text', handler);
    return () => window.removeEventListener('inkbloom:locate-text', handler);
  }, [editor]);

  // 内容插入广播：AIGC 预览/引导字段一键载入等外部入口投递 HTML 到光标处。
  // 多实例并存时事件会广播给所有编辑器，定向策略（简单可靠方案）：
  // 1. detail.target 存在 → 仅容器 data-inkbloom-editor 匹配的实例插入；
  // 2. 无 target → 仅最近一次被聚焦（focusCapture 记录）的实例插入。
  useEffect(() => {
    const handler = (e: Event) => {
      if (!editor) return;
      // plain 实例（记忆弹窗编辑器）不接收无目标的全局广播，避免 AIGC 内容误落；
      // 但 detail.target 精确命中的定向投递（弹窗自身的一键加载/AIGC 插入）必须放行
      const detail = (e as CustomEvent).detail as string | { html?: string; target?: string } | undefined;
      const target = typeof detail === 'string' ? undefined : detail?.target;
      if (isPlainRef.current && !target) return;
      const html = typeof detail === 'string' ? detail : detail?.html;
      if (!html) return;
      const el = editorRef.current;
      if (target) {
        if (el?.dataset.inkbloomEditor !== target) return;
      } else if (lastActiveEditorEl !== el) {
        return;
      }
      editor.chain().focus().insertContent(html).run();
    };
    window.addEventListener('inkbloom:insert-content', handler);
    return () => window.removeEventListener('inkbloom:insert-content', handler);
  }, [editor]);

  return (
    <div
      className="flex flex-col h-full relative"
      ref={editorRef}
      data-inkbloom-editor={insertTarget}
      onFocusCapture={() => {
        if (editorRef.current) lastActiveEditorEl = editorRef.current;
      }}
    >
      {/* AIGC 配置卡片（备忘录 L61）：所有富文本编辑器统一置于工具列表最上方 */}
      {aigcSlot && <div className="px-3 pt-2 border-b border-white/6 bg-surface-1/60">{aigcSlot}</div>}
      {/* 工具栏恒显：全局专注模式下仍可通过工具栏按钮退出专注 */}
      <Toolbar
        editor={editor}
        variant={variant}
        platform={platform}
        onSelectPlatform={onSelectPlatform}
        onAdapt={onAdapt}
        preset={toolbarPreset}
        focusable={focusable}
        focused={focused}
        onToggleFocus={onToggleFocus}
        onOpenImagePicker={() => setImagePickerOpen(true)}
      />
      {titleSlot}
      <div className="flex-1 overflow-y-auto bg-surface-0 relative">
        <div className={focusMode ? 'max-w-3xl mx-auto animate-fade-in' : ''}>
          <EditorContent editor={editor} className="h-full" />
        </div>

        {/* Inline suggestion floating indicator */}
        {inlineSuggestion && inlinePos && (
          <div
            className="fixed z-40 bg-neutral-800/95 border border-neutral-600 rounded-md shadow-lg px-3 py-2 max-w-[400px] text-sm"
            style={{ left: inlinePos.left, top: inlinePos.top }}
          >
            <p className="text-neutral-400 whitespace-pre-wrap mb-1">
              {isInlineStreaming && <span className="text-indigo-400 animate-pulse">生成中... </span>}
              {inlineSuggestion}
            </p>
            <div className="flex gap-2 text-xs text-neutral-500">
              <span className="text-neutral-400">Tab</span> 接受
              <span className="text-neutral-400">Esc</span> 取消
            </div>
          </div>
        )}

        {/* Character mention suggestion popup */}
        {suggestion.visible && editor && (
          <CharacterSuggestionPopup
            editor={editor}
            clientRect={suggestion.rect ? () => suggestion.rect : null}
            items={filteredChars}
            command={handleMentionSelect}
          />
        )}
      </div>

      {/* Slash command menu */}
      {slash.visible && slash.rect && (
        <SlashCommandMenu
          rect={slash.rect}
          items={filteredSlash}
          activeIndex={slashIndex}
          onSelect={handleSlashSelect}
          onHover={setSlashIndex}
        />
      )}

      {/* 多候选生成（N 选 1，plain 禁用） */}
      {!isPlain && <CandidatesPanel onAccept={handleAcceptCandidate} />}

      {/* Context menu（plain 禁用） */}
      {!isPlain && (
        <ContextMenu
          selectedText={ctxMenu.selectedText}
          position={ctxMenu.position}
          onClose={() => setCtxMenu({ position: null, selectedText: '' })}
        />
      )}

      {/* Diff viewer overlay（plain 禁用） */}
      {!isPlain && showDiffViewer && rewriteResult && (
        <DiffViewer
          original={rewriteResult.original}
          modified={rewriteResult.modified}
          onAccept={handleAcceptRewrite}
          onReject={() => {
            rejectRewrite();
          }}
        />
      )}

      {/* 图片选择弹窗（plain 禁用）：工具栏/斜杠命令共用 */}
      {!isPlain && (
        <ImagePickerModal
          open={imagePickerOpen}
          onClose={() => setImagePickerOpen(false)}
          editor={editor}
          variant={variant}
        />
      )}
    </div>
  );
};

export default TipTapEditor;


