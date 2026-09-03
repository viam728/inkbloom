package dto

// ── 垃圾桶（删除要点进桶 / 列表 / 重选幕恢复 / 彻底删除） ────────────────

// TrashNodeRequest is the request for POST /novels/:id/trash —
// 删除一个大纲要点进垃圾桶（后端事务内：节点摘除 + 绑定章节软删 + 快照入桶）。
type TrashNodeRequest struct {
	ActID  string `json:"act_id" binding:"required"`
	NodeID string `json:"node_id" binding:"required"`
}

// RestoreTrashRequest is the request for POST /novels/:id/trash/:tid/restore —
// 恢复时重选幕间归属；TargetActID 为空则在末尾新建幕。
type RestoreTrashRequest struct {
	TargetActID string `json:"target_act_id,omitempty"`
}
