import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface MemoNote {
  id: string;
  title: string;
  content: string;
  updated_at: number;
}

/** 简约随记模式：本地轻量笔记，无需作品结构，快速捕捉灵感 */
interface MemoState {
  notes: MemoNote[];
  currentId: string | null;

  createNote: () => string;
  deleteNote: (id: string) => void;
  selectNote: (id: string) => void;
  updateNote: (id: string, patch: Partial<Pick<MemoNote, 'title' | 'content'>>) => void;
  reorderNotes: (orderedIds: string[]) => void;
}

export const useMemoStore = create<MemoState>()(
  persist(
    (set) => ({
      notes: [],
      currentId: null,

      createNote: () => {
        const id = crypto.randomUUID();
        const note: MemoNote = {
          id,
          title: '未命名随记',
          content: '',
          updated_at: Date.now(),
        };
        set((s) => ({ notes: [note, ...s.notes], currentId: id }));
        return id;
      },

      deleteNote: (id) => {
        set((s) => {
          const notes = s.notes.filter((n) => n.id !== id);
          return {
            notes,
            currentId: s.currentId === id ? (notes[0]?.id ?? null) : s.currentId,
          };
        });
      },

      selectNote: (id) => set({ currentId: id }),

      updateNote: (id, patch) => {
        set((s) => ({
          notes: s.notes.map((n) =>
            n.id === id ? { ...n, ...patch, updated_at: Date.now() } : n,
          ),
        }));
      },

      reorderNotes: (orderedIds) => {
        set((s) => {
          const byId = new Map(s.notes.map((n) => [n.id, n]));
          const next: MemoNote[] = [];
          orderedIds.forEach((id) => {
            const n = byId.get(id);
            if (n) {
              next.push(n);
              byId.delete(id);
            }
          });
          byId.forEach((n) => next.push(n));
          return { notes: next };
        });
      },
    }),
    { name: 'inkbloom-memo' },
  ),
);

/** 获取当前笔记（含自动创建首条） */
export const useCurrentMemo = () => {
  const notes = useMemoStore((s) => s.notes);
  const currentId = useMemoStore((s) => s.currentId);
  return notes.find((n) => n.id === currentId) ?? null;
};
