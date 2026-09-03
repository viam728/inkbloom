package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// ErrTrashNotFound 回收记录不存在（或不属于该用户/作品）。
var ErrTrashNotFound = errors.New("回收记录不存在")

// TrashService 垃圾桶：删除大纲要点时「章节 + 节点 + 正文」一起进桶；恢复时
// 重选目标幕插回大纲、复活章节。所有变更在单事务内完成，保证大纲文档、
// chapters 行与回收记录三者一致（否则又会造出幽灵绑定）。
type TrashService struct {
	db        *gorm.DB
	novelRepo repository.NovelRepository
}

func NewTrashService(db *gorm.DB, novelRepo repository.NovelRepository) *TrashService {
	return &TrashService{db: db, novelRepo: novelRepo}
}

// TrashNode 删除一个大纲要点：节点从大纲文档摘除、绑定的章节软删，
// 二者连同正文快照写入垃圾桶，一个事务提交。纯规划节点（无正文）同样进桶，
// 恢复逻辑统一。
func (s *TrashService) TrashNode(ctx context.Context, userID, novelID int64, actID, nodeID string) (*model.ChapterTrash, error) {
	if actID == "" || nodeID == "" {
		return nil, errors.New("act_id 与 node_id 不能为空")
	}
	var out *model.ChapterTrash
	err := s.db.Transaction(func(tx *gorm.DB) error {
		// 作品归属校验（用户隔离，C3）。
		var cnt int64
		if err := tx.Model(&model.Novel{}).Where("id = ? AND user_id = ?", novelID, userID).Count(&cnt).Error; err != nil {
			return err
		}
		if cnt == 0 {
			return gorm.ErrRecordNotFound
		}

		// 读大纲文档并定位节点。
		var doc model.NovelOutline
		if err := tx.Where("novel_id = ? AND user_id = ?", novelID, userID).First(&doc).Error; err != nil {
			return fmt.Errorf("读取大纲失败: %w", err)
		}
		acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(doc.Acts)))
		if !ok {
			return errors.New("大纲文档解析失败")
		}

		var (
			node      map[string]any
			actTitle  string
			nodeFound bool
		)
		for _, act := range acts {
			if id, _ := act["id"].(string); id != actID {
				continue
			}
			actTitle, _ = act["title"].(string)
			nodes := actNodes(act)
			for i, n := range nodes {
				if id, _ := n["id"].(string); id == nodeID {
					node = n
					nodes = append(nodes[:i], nodes[i+1:]...)
					act["nodes"] = nodes // 写回过滤后的节点列表
					nodeFound = true
					break
				}
			}
			break
		}
		if !nodeFound {
			return gorm.ErrRecordNotFound
		}
		nodeJSON, err := json.Marshal(node)
		if err != nil {
			return err
		}

		// 绑定章节：软删 + 快照进桶。
		trash := &model.ChapterTrash{
			UserID:   userID,
			NovelID:  novelID,
			NodeJSON: datatypes.JSON(nodeJSON),
			ActID:    actID,
			ActTitle: actTitle,
		}
		if t, _ := node["title"].(string); t != "" {
			trash.NodeTitle = t
		}
		if cid, ok := node["chapter_id"].(float64); ok && cid > 0 {
			var ch model.Chapter
			if err := tx.Where("id = ? AND user_id = ? AND novel_id = ?", int64(cid), userID, novelID).First(&ch).Error; err != nil {
				return fmt.Errorf("读取绑定章节失败: %w", err)
			}
			if err := tx.Delete(&ch).Error; err != nil { // GORM soft delete
				return err
			}
			trash.ChapterID = ch.ID
			trash.ChapterTitle = ch.Title
			if ch.Content != nil {
				trash.Content = *ch.Content
			}
			trash.WordCount = ch.WordCount
		}
		if err := tx.Create(trash).Error; err != nil {
			return err
		}

		// 大纲文档写回（摘除节点后），版本自增。
		out2, err := json.Marshal(acts)
		if err != nil {
			return err
		}
		if err := tx.Model(&model.NovelOutline{}).
			Where("novel_id = ? AND user_id = ?", novelID, userID).
			Updates(map[string]any{"acts": datatypes.JSON(out2), "version": gorm.Expr("version + 1")}).Error; err != nil {
			return err
		}
		out = trash
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// TrashItem 是回收站列表条目（脱去正文大字段的轻量视图）。
type TrashItem struct {
	ID           int64  `json:"id"`
	ChapterID    int64  `json:"chapter_id"`
	ChapterTitle string `json:"chapter_title"`
	NodeTitle    string `json:"node_title"`
	ActTitle     string `json:"act_title"`
	WordCount    int    `json:"word_count"`
	CreatedAt    string `json:"created_at"`
}

// List 返回某部作品的回收站列表（新→旧）。
func (s *TrashService) List(ctx context.Context, userID, novelID int64) ([]TrashItem, error) {
	var rows []model.ChapterTrash
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND novel_id = ?", userID, novelID).
		Order("id DESC").Limit(200).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]TrashItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, TrashItem{
			ID:           r.ID,
			ChapterID:    r.ChapterID,
			ChapterTitle: r.ChapterTitle,
			NodeTitle:    r.NodeTitle,
			ActTitle:     r.ActTitle,
			WordCount:    r.WordCount,
			CreatedAt:    r.CreatedAt.Format("2006-01-02 15:04"),
		})
	}
	return items, nil
}

// Restore 把一条回收记录恢复进大纲：节点插回用户重选的目标幕
// （targetActID 为空则在末尾新建幕「恢复的章节」），绑定章节复活
// （position 被占用时回退到末尾），最后删除回收记录。
func (s *TrashService) Restore(ctx context.Context, userID, novelID, trashID int64, targetActID string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		var trash model.ChapterTrash
		if err := tx.Where("id = ? AND user_id = ? AND novel_id = ?", trashID, userID, novelID).
			First(&trash).Error; err != nil {
			return ErrTrashNotFound
		}

		var node map[string]any
		if err := json.Unmarshal(trash.NodeJSON, &node); err != nil || node == nil {
			return fmt.Errorf("节点快照损坏: %w", err)
		}

		// 复活绑定章节（含正文快照回填；chapters 行可能已被彻底清理 → 重建）。
		if trash.ChapterID > 0 {
			var ch model.Chapter
			err := tx.Unscoped().
				Where("id = ? AND user_id = ? AND novel_id = ?", trash.ChapterID, userID, novelID).
				First(&ch).Error
			switch {
			case err == nil:
				// 行存在：若是软删态则复活；position 被活跃章节占用时回退到末尾。
				content := trash.Content
				updates := map[string]any{
					"deleted_at": nil,
					"content":    &content,
					"word_count": trash.WordCount,
				}
				var posCnt int64
				if err := tx.Model(&model.Chapter{}).
					Where("novel_id = ? AND position = ? AND id <> ? AND deleted_at IS NULL", novelID, ch.Position, ch.ID).
					Count(&posCnt).Error; err != nil {
					return err
				}
				if posCnt > 0 {
					var maxPos *int
					if err := tx.Model(&model.Chapter{}).
						Select("MAX(position)").
						Where("novel_id = ? AND user_id = ? AND deleted_at IS NULL", novelID, userID).
						Scan(&maxPos).Error; err != nil {
						return err
					}
					if maxPos != nil {
						updates["position"] = *maxPos + 1
					}
				}
				// Unscoped 必须：Updates 在软删行上默认附加 deleted_at IS NULL，
				// 复活更新会静默落空。
				if err := tx.Unscoped().Model(&model.Chapter{}).Where("id = ?", ch.ID).Updates(updates).Error; err != nil {
					return err
				}
			case errors.Is(err, gorm.ErrRecordNotFound):
				// 行没了：用快照重建（position 追加到末尾，规避唯一索引冲突）。
				var maxPos *int
				if err := tx.Model(&model.Chapter{}).
					Select("MAX(position)").
					Where("novel_id = ? AND user_id = ? AND deleted_at IS NULL", novelID, userID).
					Scan(&maxPos).Error; err != nil {
					return err
				}
				next := 0
				if maxPos != nil {
					next = *maxPos + 1
				}
				ch = model.Chapter{
					ID: trash.ChapterID, UserID: userID, NovelID: novelID,
					Title: trash.ChapterTitle, Content: &trash.Content,
					WordCount: trash.WordCount, Status: "draft", Position: next,
				}
				if err := tx.Create(&ch).Error; err != nil {
					return err
				}
			default:
				return err
			}
		}

		// 节点插回目标幕（不存在/未指定 → 末尾新建幕）。
		var doc model.NovelOutline
		if err := tx.Where("novel_id = ? AND user_id = ?", novelID, userID).First(&doc).Error; err != nil {
			return fmt.Errorf("读取大纲失败: %w", err)
		}
		acts, ok := parseOutlineActs(normalizeOutlineActsJSON(json.RawMessage(doc.Acts)))
		if !ok {
			return errors.New("大纲文档解析失败")
		}
		inserted := false
		if targetActID != "" {
			for _, act := range acts {
				if id, _ := act["id"].(string); id == targetActID {
					nodes := actNodes(act)
					act["nodes"] = append(nodes, node)
					inserted = true
					break
				}
			}
		}
		if !inserted {
			acts = append(acts, map[string]any{
				"id":    fmt.Sprintf("restore-%d-%d", trashID, trash.ChapterID),
				"title": "恢复的章节",
				"nodes": []map[string]any{node},
			})
		}
		out, err := json.Marshal(acts)
		if err != nil {
			return err
		}
		if err := tx.Model(&model.NovelOutline{}).
			Where("novel_id = ? AND user_id = ?", novelID, userID).
			Updates(map[string]any{"acts": datatypes.JSON(out), "version": gorm.Expr("version + 1")}).Error; err != nil {
			return err
		}

		// 出桶。
		return tx.Delete(&trash).Error
	})
}

// Purge 彻底删除：物理删除章节行（连同正文）与回收记录，不可恢复。
func (s *TrashService) Purge(ctx context.Context, userID, novelID, trashID int64) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		var trash model.ChapterTrash
		if err := tx.Where("id = ? AND user_id = ? AND novel_id = ?", trashID, userID, novelID).
			First(&trash).Error; err != nil {
			return ErrTrashNotFound
		}
		if trash.ChapterID > 0 {
			if err := tx.Unscoped().
				Where("id = ? AND user_id = ? AND novel_id = ?", trash.ChapterID, userID, novelID).
				Delete(&model.Chapter{}).Error; err != nil {
				return err
			}
		}
		return tx.Delete(&trash).Error
	})
}
