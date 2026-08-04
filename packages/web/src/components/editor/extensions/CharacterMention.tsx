import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import React from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { useNovelStore } from '@/stores/novel-store';

/**
 * CharacterMention — @角色名 triggers a character list popup.
 * Selecting a character inserts a blue-highlighted mention node.
 */

interface CharacterMentionViewProps {
  node: {
    attrs: {
      characterName: string;
      characterId: number;
    };
  };
}

const CharacterMentionView: React.FC<CharacterMentionViewProps> = ({ node }) => {
  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className="inline-flex items-center bg-blue-900/30 text-blue-300 px-1 rounded text-sm font-medium cursor-default"
        contentEditable={false}
      >
        @{node.attrs.characterName}
      </span>
    </NodeViewWrapper>
  );
};

/**
 * Floating popup that appears when typing @.
 * Shows character list from novel-store for selection.
 */
export interface CharacterSuggestionPopupProps {
  editor: any;
  clientRect?: (() => DOMRect | null) | null;
  items: Array<{ name: string; id: number }>;
  command: (attrs: { characterName: string; characterId: number }) => void;
}

export const CharacterSuggestionPopup: React.FC<CharacterSuggestionPopupProps> = ({
  clientRect,
  items,
  command,
}) => {
  const rect = clientRect?.() ?? null;
  if (!rect || items.length === 0) return null;

  return (
    <div
      className="fixed z-50 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl py-1 min-w-[140px] max-h-[200px] overflow-y-auto"
      style={{ left: rect.left, top: rect.bottom + 4 }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            command({ characterName: item.name, characterId: item.id });
          }}
        >
          {item.name}
        </button>
      ))}
    </div>
  );
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    characterMention: {
      insertCharacterMention: (attrs: { characterName: string; characterId: number }) => ReturnType;
    };
  }
}

const CharacterMention = Node.create({
  name: 'characterMention',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      characterName: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-character-name'),
        renderHTML: (attributes) => ({
          'data-character-name': attributes.characterName,
        }),
      },
      characterId: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-character-id') ?? 0),
        renderHTML: (attributes) => ({
          'data-character-id': attributes.characterId,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="character-mention"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'character-mention',
        class: 'inline-flex items-center bg-blue-900/30 text-blue-300 px-1 rounded text-sm font-medium',
      }),
      `@${HTMLAttributes['data-character-name'] ?? ''}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CharacterMentionView as any);
  },

  addCommands() {
    return {
      insertCharacterMention:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          });
        },
    };
  },
});

/**
 * Helper: Get characters from the novel store for the suggestion popup.
 */
export function getCharactersForMention(): Array<{ name: string; id: number }> {
  const state = useNovelStore.getState();
  const novel = state.currentNovel;
  if (!novel) return [];

  // Characters are fetched as part of the novel data
  // Access them from the novel's characters association or a separate store
  // For now we return an empty array; the editor component can pass characters via props
  return (novel as any).characters ?? [];
}

export default CharacterMention;
