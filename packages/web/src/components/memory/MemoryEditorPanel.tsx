import React, { useEffect } from 'react';
import { useNovelStore } from '@/stores/novel-store';
import { useMemoryStore, type MemoryType } from '@/stores/memory-store';
import { useTabStore, type TabMeta } from '@/stores/tab-store';
import { useToast } from '@/components/common/Toast';
import { MemoryEditorContent, type MemoryEditorPayload } from './MemoryEditorModal';

interface MemoryEditorPanelProps {
  tabKey: string;
  meta: TabMeta;
}

/**
 * 记忆条目编辑器（中央标签页）：novel 作用域的条目编辑从弹窗迁移至此，
 * 复用 MemoryEditorModal 的内容组件（variant="tab"，无弹窗外壳）。
 * 提交成功 / 条目被删除时自动关闭本 tab。
 */
const MemoryEditorPanel: React.FC<MemoryEditorPanelProps> = ({ tabKey, meta }) => {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const novelId = currentNovel?.id;
  const items = useMemoryStore((s) => (novelId ? s.byNovel[novelId] : undefined));
  const item = meta.itemId ? items?.find((i) => i.id === meta.itemId) ?? null : null;
  const { showToast } = useToast();

  // 条目被删除（加载完成后的空命中）→ 自动关闭
  useEffect(() => {
    if (meta.itemId && items && !item) useTabStore.getState().closeTab(tabKey);
  }, [meta.itemId, items, item, tabKey]);

  const handleSubmit = async (payload: MemoryEditorPayload) => {
    if (!novelId) return;
    if (meta.itemId) {
      await useMemoryStore.getState().updateItem(novelId, meta.itemId, payload);
      showToast('记忆条目已更新', 'success');
    } else {
      await useMemoryStore.getState().addItem(novelId, payload);
      showToast('已加入作品记忆', 'success');
    }
    useTabStore.getState().closeTab(tabKey);
  };

  return (
    <MemoryEditorContent
      scope="novel"
      novelId={novelId}
      item={item}
      defaultType={(meta.newType as MemoryType) ?? 'character'}
      onSubmit={handleSubmit}
      onClose={() => useTabStore.getState().closeTab(tabKey)}
      allItems={items ?? []}
      instanceKey={tabKey}
      variant="tab"
    />
  );
};

export default MemoryEditorPanel;
