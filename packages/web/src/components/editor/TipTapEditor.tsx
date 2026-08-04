import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
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
import CandidatesPanel, { setLastCandidatesContext } from './CandidatesPanel';
import { useAIStore } from '@/stores/ai-store';
import { useNovelStore } from '@/stores/novel-store';
import { useUIStore } from '@/stores/ui-store';
import { useCandidatesStore } from '@/stores/candidates-store';

interface TipTapEditorProps {
  content: string;
  onChange: (html: string) => void;
  onWordCount?: (count: number) => void;
  onExport?: () => void;
  /** 编辑器变体：novel 含角色@提及/章节分隔/行内续写等小说专属能力 */
  variant?: EditorVariant;
  placeholder?: string;
  /** 工具栏导出按钮右侧的额外插槽 */
  afterExport?: React.ReactNode;
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

const TipTapEditor: React.FC<TipTapEditorProps> = ({
  content,
  onChange,
  onWordCount,
  onExport,
  variant = 'novel',
  placeholder,
  afterExport,
}) => {
  const isNovel = variant === 'novel';
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const currentChapter = useNovelStore((s) => s.currentChapter);
  const focusMode = useUIStore((s) => s.focusMode);
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
  const editorRef = useRef<HTMLDivElement>(null);

  // Characters for mention suggestion popup
  const characters: Array<{ name: string; id: number }> = (currentNovel as any)?.characters ?? [];

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      Image,
      Placeholder.configure({
        placeholder: placeholder ?? '开始写作...',
      }),
      // 小说专属扩展：章节分隔与角色@提及
      ...(isNovel ? [ChapterBreak, CharacterMention] : []),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: content || '',
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      onChange(html);

      // Word count
      const text = ed.state.doc.textContent;
      const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
      onWordCount?.(chineseChars + englishWords);

      // Check for @ mention trigger（仅小说模式）
      const { state } = ed;
      const { $from } = state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0');
      if (isNovel) {
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

      // Check for / slash command trigger（行内独立斜杠开头）
      const slashMatch = textBefore.match(/\/([\u4e00-\u9fff\w-]*)$/);
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
          'prose prose-invert max-w-none min-h-[400px] px-8 py-6 focus:outline-none text-neutral-200',
      },
      handleDOMEvents: {
        contextmenu: (view, event) => {
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

        // Ctrl+Space → inline completion（仅小说模式）
        if (event.ctrlKey && event.code === 'Space' && isNovelRef.current) {
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

        // Esc → 退出专注模式（无建议时）
        if (event.key === 'Escape' && useUIStore.getState().focusMode) {
          useUIStore.getState().exitFocusMode();
          return true;
        }

        return false;
      },
    },
  });

  // Sync external content changes
  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    if (currentHtml !== content && content !== '') {
      editor.commands.setContent(content);
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

  // Handle accepting rewrite: replace selected text in editor
  const handleAcceptRewrite = useCallback(() => {
    if (!editor || !rewriteResult) return;
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
  }, [editor, rewriteResult, acceptRewrite]);

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
    (text: string) => {
      if (!editor) return;
      const nodes = text.split('\n').map((line) => ({
        type: 'paragraph',
        content: line.trim() ? [{ type: 'text', text: line }] : [],
      }));
      editor.chain().focus().insertContent(nodes).run();
    },
    [editor],
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

  return (
    <div className="flex flex-col h-full relative" ref={editorRef}>
      {!focusMode && <Toolbar editor={editor} onExport={onExport} variant={variant} afterExport={afterExport} />}
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

      {/* 多候选生成（N 选 1） */}
      <CandidatesPanel onAccept={handleAcceptCandidate} />

      {/* Context menu */}
      <ContextMenu
        selectedText={ctxMenu.selectedText}
        position={ctxMenu.position}
        onClose={() => setCtxMenu({ position: null, selectedText: '' })}
      />

      {/* Diff viewer overlay */}
      {showDiffViewer && rewriteResult && (
        <DiffViewer
          original={rewriteResult.original}
          modified={rewriteResult.modified}
          onAccept={handleAcceptRewrite}
          onReject={() => {
            rejectRewrite();
          }}
        />
      )}
    </div>
  );
};

export default TipTapEditor;
