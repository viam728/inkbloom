import apiClient from './api-client';

/** 垃圾桶：删除要点进桶（章节+节点+正文一起）/ 列表 / 重选幕恢复 / 彻底删除。 */

export interface TrashItem {
  id: number;
  chapter_id: number;
  chapter_title: string;
  node_title: string;
  act_title: string;
  word_count: number;
  created_at: string;
}

/** 删除一个大纲要点进桶（后端事务：节点摘除 + 绑定章节软删 + 快照入桶） */
export async function trashNode(
  novelId: number,
  actId: string,
  nodeId: string,
): Promise<TrashItem> {
  return (await apiClient.post(`/novels/${novelId}/trash`, {
    act_id: actId,
    node_id: nodeId,
  })) as unknown as TrashItem;
}

export async function listTrash(novelId: number): Promise<TrashItem[]> {
  return (await apiClient.get(`/novels/${novelId}/trash`)) as unknown as TrashItem[];
}

/** 恢复进大纲；targetActId 为空则在末尾新建幕「恢复的章节」 */
export async function restoreTrash(
  novelId: number,
  trashId: number,
  targetActId: string,
): Promise<void> {
  await apiClient.post(`/novels/${novelId}/trash/${trashId}/restore`, {
    target_act_id: targetActId || undefined,
  });
}

/** 彻底删除（物理删除章节行与回收记录，不可恢复） */
export async function purgeTrash(novelId: number, trashId: number): Promise<void> {
  await apiClient.delete(`/novels/${novelId}/trash/${trashId}`);
}
