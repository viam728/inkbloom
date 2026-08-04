import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import React from 'react';
import { NodeViewWrapper } from '@tiptap/react';

/**
 * ChapterBreak — a custom TipTap node rendered as a horizontal rule
 * with a "章节分隔" label. Insert via `/---` or toolbar button.
 */

const ChapterBreakView: React.FC = () => {
  return (
    <NodeViewWrapper>
      <div className="flex items-center gap-3 my-4 select-none" contentEditable={false}>
        <div className="flex-1 h-px bg-neutral-600" />
        <span className="text-xs text-neutral-500 uppercase tracking-wider">章节分隔</span>
        <div className="flex-1 h-px bg-neutral-600" />
      </div>
    </NodeViewWrapper>
  );
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    chapterBreak: {
      /** Insert a chapter break divider */
      setChapterBreak: () => ReturnType;
    };
  }
}

const ChapterBreak = Node.create({
  name: 'chapterBreak',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-type="chapter-break"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'chapter-break' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChapterBreakView as any);
  },

  addCommands() {
    return {
      setChapterBreak:
        () =>
        ({ commands }) => {
          return commands.insertContent({ type: this.name });
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // Type "---" and press Enter to insert
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from } = state.selection;
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\0');
        if (textBefore.endsWith('---')) {
          return editor
            .chain()
            .command(({ tr, dispatch }) => {
              if (dispatch) {
                const from = $from.start();
                const to = $from.pos;
                tr.delete(from, to);
              }
              return true;
            })
            .setChapterBreak()
            .run();
        }
        return false;
      },
    };
  },
});

export default ChapterBreak;
