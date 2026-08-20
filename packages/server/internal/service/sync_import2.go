package service

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// importMedia merges the media workspace: contents matched by id or title
// (newer updated_at wins), topics matched by id or title (updated in place),
// memory merged whole (newer updated_at — or version fallback — wins; the
// loser is skipped and explained in the response message).
func (s *SyncService) importMedia(ctx context.Context, tx *gorm.DB, userID int64, m *importManifest, files map[string]*zip.File, result *ImportResult, written *[]string) error {
	var existingContents []model.MediaContent
	if err := tx.Scopes(scope.ForUser(userID)).Find(&existingContents).Error; err != nil {
		return fmt.Errorf("load media contents: %w", err)
	}
	byID := map[int64]*model.MediaContent{}
	byTitle := map[string]*model.MediaContent{}
	for i := range existingContents {
		byID[existingContents[i].ID] = &existingContents[i]
		byTitle[existingContents[i].Title] = &existingContents[i]
	}

	for i := range m.Media.Contents {
		pc := m.Media.Contents[i]
		cur := byID[pc.ID]
		if cur == nil {
			cur = byTitle[pc.Title]
		}
		if cur == nil {
			newContent, err := s.rewriteTextAssetRefs(pc.Content, 0, files, result, written)
			if err != nil {
				return err
			}
			row := model.MediaContent{
				UserID: userID, Title: pc.Title, Platform: pc.Platform,
				Content: newContent, Tags: pc.Tags, Position: pc.Position,
			}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("create media content %q: %w", pc.Title, err)
			}
			result.Created["media_contents"]++
			continue
		}
		if pc.UpdatedAt.After(cur.UpdatedAt) {
			// Copy referenced assets only when the package actually wins;
			// skipped rows must not produce side effects (idempotent re-import).
			newContent, err := s.rewriteTextAssetRefs(pc.Content, 0, files, result, written)
			if err != nil {
				return err
			}
			if err := tx.Model(&model.MediaContent{}).Where("id = ? AND user_id = ?", cur.ID, userID).Updates(map[string]interface{}{
				"platform":   pc.Platform,
				"content":    newContent,
				"tags":       pc.Tags,
				"position":   pc.Position,
				"updated_at": time.Now(),
			}).Error; err != nil {
				return err
			}
			result.Updated++
		} else {
			result.Skipped++
		}
	}

	var existingTopics []model.MediaTopic
	if err := tx.Scopes(scope.ForUser(userID)).Find(&existingTopics).Error; err != nil {
		return fmt.Errorf("load media topics: %w", err)
	}
	topicByID := map[string]*model.MediaTopic{}
	topicByTitle := map[string]*model.MediaTopic{}
	for i := range existingTopics {
		topicByID[existingTopics[i].ID] = &existingTopics[i]
		topicByTitle[existingTopics[i].Title] = &existingTopics[i]
	}
	for i := range m.Media.Topics {
		pt := m.Media.Topics[i]
		note, err := s.rewriteTextAssetRefs(pt.Note, 0, files, result, written)
		if err != nil {
			return err
		}
		cur := topicByID[pt.ID]
		if cur == nil {
			cur = topicByTitle[pt.Title]
		}
		if cur != nil {
			// Topics carry no updated_at: refresh metadata in place.
			if err := tx.Model(&model.MediaTopic{}).Where("id = ? AND user_id = ?", cur.ID, userID).Updates(map[string]interface{}{
				"note": note, "status": pt.Status, "position": pt.Position,
			}).Error; err != nil {
				return err
			}
			result.Updated++
			continue
		}
		row := model.MediaTopic{
			ID: uuid.New().String(), UserID: userID, Title: pt.Title,
			Note: note, Status: pt.Status, Position: pt.Position,
		}
		if err := tx.Create(&row).Error; err != nil {
			return fmt.Errorf("create media topic %q: %w", pt.Title, err)
		}
		result.Created["media_topics"]++
	}

	return s.importMediaMemory(ctx, tx, userID, m, result)
}

// importMediaMemory merges the single-row media memory document. The frozen
// payload shape is {items, version} plus an additive updated_at; when the
// timestamp is absent the version number is the fallback ordering.
func (s *SyncService) importMediaMemory(ctx context.Context, tx *gorm.DB, userID int64, m *importManifest, result *ImportResult) error {
	pkg := m.Media.Memory
	if pkg == nil || len(pkg.Items) == 0 {
		return nil
	}
	var cur model.MediaMemory
	err := tx.Scopes(scope.ForUser(userID)).First(&cur).Error
	if err != nil && err != gorm.ErrRecordNotFound {
		return err
	}
	currentEmpty := err == gorm.ErrRecordNotFound || (cur.Version == 0 && len(cur.Items) <= 2)

	if currentEmpty {
		doc := &model.MediaMemory{UserID: userID, Items: datatypes.JSON(pkg.Items), Version: pkg.Version}
		if err := s.upsertMediaMemoryRow(ctx, tx, doc); err != nil {
			return err
		}
		result.Created["media_memory"]++
		return nil
	}

	pkgWins := false
	if pkg.UpdatedAt != nil {
		pkgWins = pkg.UpdatedAt.After(cur.UpdatedAt)
	} else {
		pkgWins = pkg.Version > cur.Version
	}
	if !pkgWins {
		result.Skipped++
		if result.Message == "" {
			result.Message = "媒体记忆库内版本更新，包内数据已跳过"
		}
		return nil
	}
	doc := &model.MediaMemory{UserID: userID, Items: datatypes.JSON(pkg.Items), Version: pkg.Version}
	if err := s.upsertMediaMemoryRow(ctx, tx, doc); err != nil {
		return err
	}
	result.Updated++
	return nil
}

// upsertMediaMemoryRow writes the media memory row inside the import
// transaction, preserving the package version instead of auto-incrementing.
func (s *SyncService) upsertMediaMemoryRow(ctx context.Context, tx *gorm.DB, doc *model.MediaMemory) error {
	if doc.Version <= 0 {
		doc.Version = 1
	}
	return tx.Where(model.MediaMemory{UserID: doc.UserID}).
		Assign(model.MediaMemory{Items: doc.Items, Version: doc.Version, UpdatedAt: time.Now()}).
		FirstOrCreate(doc).Error
}

// importKnowledge appends knowledge nodes (deduplicated by name within the
// target novel) and edges (deduplicated by their unique tuple). Nodes whose
// novel was not imported are skipped; edges with unmapped endpoints too.
func (s *SyncService) importKnowledge(ctx context.Context, tx *gorm.DB, userID int64, m *importManifest, novelIDMap map[int64]int64, result *ImportResult) error {
	// oldNodeID → node id in the current library (created or matched).
	nodeIDMap := map[int64]int64{}

	for i := range m.Knowledge.Nodes {
		pn := m.Knowledge.Nodes[i]
		targetNovel, ok := novelIDMap[pn.NovelID]
		if !ok {
			result.Skipped++
			continue
		}
		var existing model.KnowledgeNode
		err := tx.Scopes(scope.ForUser(userID)).
			Where("novel_id = ? AND name = ?", targetNovel, pn.Name).First(&existing).Error
		if err == nil {
			nodeIDMap[pn.ID] = existing.ID
			result.Skipped++
			continue
		}
		if err != gorm.ErrRecordNotFound {
			return err
		}
		node := model.KnowledgeNode{
			UserID: userID, NovelID: targetNovel, Name: pn.Name,
			Type: pn.Type, Properties: pn.Properties,
		}
		if err := tx.Create(&node).Error; err != nil {
			return fmt.Errorf("create knowledge node %q: %w", pn.Name, err)
		}
		nodeIDMap[pn.ID] = node.ID
		result.Created["knowledge_nodes"]++
	}

	for i := range m.Knowledge.Edges {
		pe := m.Knowledge.Edges[i]
		targetNovel, ok := novelIDMap[pe.NovelID]
		if !ok {
			result.Skipped++
			continue
		}
		srcID, okS := nodeIDMap[pe.SourceID]
		dstID, okT := nodeIDMap[pe.TargetID]
		if !okS || !okT {
			result.Skipped++
			continue
		}
		var count int64
		if err := tx.Model(&model.KnowledgeEdge{}).Scopes(scope.ForUser(userID)).
			Where("novel_id = ? AND source_id = ? AND target_id = ? AND relation_type = ?",
				targetNovel, srcID, dstID, pe.RelationType).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			result.Skipped++
			continue
		}
		edge := model.KnowledgeEdge{
			UserID: userID, NovelID: targetNovel, SourceID: srcID, TargetID: dstID,
			RelationType: pe.RelationType, Description: pe.Description,
		}
		if err := tx.Create(&edge).Error; err != nil {
			return fmt.Errorf("create knowledge edge: %w", err)
		}
		result.Created["knowledge_edges"]++
	}
	return nil
}

// ── asset helpers ──────────────────────────────────────────────────────────

// rewriteTextAssetRefs copies every @@asset-referenced package file into
// the current user's storage and substitutes the fresh URLs into text.
// novelID == 0 stores under the media area.
func (s *SyncService) rewriteTextAssetRefs(text string, novelID int64, files map[string]*zip.File, result *ImportResult, written *[]string) (string, error) {
	if text == "" || !strings.Contains(text, assetRefPrefix) {
		return text, nil
	}
	var firstErr error
	out := assetRefPattern.ReplaceAllStringFunc(text, func(m string) string {
		// copyPackageAsset expects the full "@@asset:..." token.
		url, err := s.copyPackageAsset(files, m, novelID, result, written)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return m
		}
		if url == "" {
			return m
		}
		return url
	})
	return out, firstErr
}

// rewriteRawAssetRefs applies rewriteTextAssetRefs to a raw JSON payload.
func (s *SyncService) rewriteRawAssetRefs(raw []byte, novelID int64, files map[string]*zip.File, result *ImportResult, written *[]string) ([]byte, error) {
	out, err := s.rewriteTextAssetRefs(string(raw), novelID, files, result, written)
	return []byte(out), err
}

// copyPackageAsset resolves one @@asset reference: the referenced package
// entry is copied into the storage root (UUID filename, existing layout)
// and an asset row is recorded. Returns "" when ref is not an asset token.
func (s *SyncService) copyPackageAsset(files map[string]*zip.File, ref string, novelID int64, result *ImportResult, written *[]string) (string, error) {
	if files == nil || !strings.HasPrefix(ref, assetRefPrefix) {
		return "", nil
	}
	pkgPath := strings.TrimPrefix(ref, assetRefPrefix)

	f, ok := files[pkgPath]
	if !ok {
		// Referenced file missing from the package: leave untouched.
		return "", nil
	}

	dir, urlBase, relSub, err := s.assetTargetLocation(pkgPath, novelID)
	if err != nil {
		return "", err
	}

	subDir := filepath.Dir(filepath.FromSlash(relSub))
	name := uuid.New().String() + strings.ToLower(filepath.Ext(relSub))
	target := filepath.Join(dir, subDir, name)
	if err := s.fs.EnsureDir(filepath.Dir(target)); err != nil {
		return "", fmt.Errorf("create asset dir: %w", err)
	}

	rc, err := f.Open()
	if err != nil {
		return "", fmt.Errorf("%w: open package asset %s: %v", ErrImportPackage, pkgPath, err)
	}
	defer rc.Close()
	dst, err := os.Create(target)
	if err != nil {
		return "", fmt.Errorf("create asset file: %w", err)
	}
	if _, err := io.Copy(dst, io.LimitReader(rc, importMaxBytes)); err != nil {
		dst.Close()
		os.Remove(target)
		return "", fmt.Errorf("copy asset file: %w", err)
	}
	if err := dst.Close(); err != nil {
		return "", fmt.Errorf("close asset file: %w", err)
	}
	if written != nil {
		*written = append(*written, target)
	}

	if result != nil {
		result.Created["assets"]++
	}
	url := urlBase + "/" + filepath.ToSlash(filepath.Join(subDir, name))
	return url, nil
}

// assetTargetLocation derives the storage directory, the URL base and the
// sub-path (inside the package) for one asset entry. Layout rules mirror
// the export: "<novelID>/assets/<sub>" maps onto the matched/created
// novel's asset dir; "_media/<sub>" stays under the shared media dir.
// The caller appends the freshly generated UUID filename to both paths.
func (s *SyncService) assetTargetLocation(pkgPath string, novelID int64) (dir, urlBase, relSub string, err error) {
	rel := strings.TrimPrefix(pkgPath, "assets/")
	if rel == pkgPath {
		return "", "", "", fmt.Errorf("%w: malformed asset reference %q", ErrImportPackage, pkgPath)
	}
	seg, rest, hasSeg := strings.Cut(rel, "/")
	if !hasSeg || rest == "" {
		return "", "", "", fmt.Errorf("%w: malformed asset reference %q", ErrImportPackage, pkgPath)
	}
	if seg == "_media" {
		return filepath.Join(s.fs.NovelAssetDir(0), "_media"),
			"/assets/files/_media", rest, nil
	}
	if _, numErr := strconv.ParseInt(seg, 10, 64); numErr != nil {
		return "", "", "", fmt.Errorf("%w: malformed asset reference %q", ErrImportPackage, pkgPath)
	}
	sub := strings.TrimPrefix(rest, "assets/")
	if novelID <= 0 {
		// No owning novel (e.g. media-scoped reference): media area.
		return filepath.Join(s.fs.NovelAssetDir(0), "_media"),
			"/assets/files/_media", sub, nil
	}
	// The package's numeric segment only identifies the source novel; the
	// file is stored under the importing novel's own asset directory so
	// ownership follows the current library (cross-account migration safe).
	return s.fs.NovelAssetDir(novelID),
		fmt.Sprintf("/assets/files/%d/assets", novelID), sub, nil
}

// recomputeWordCount refreshes novels.word_count from its live chapters.
func (s *SyncService) recomputeWordCount(tx *gorm.DB, userID, novelID int64) {
	_ = tx.Model(&model.Novel{}).
		Where("id = ? AND user_id = ?", novelID, userID).
		UpdateColumn("word_count", gorm.Expr(
			"(SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ? AND user_id = ? AND deleted_at IS NULL)",
			novelID, userID,
		)).Error
}

// remapNullableID maps a nullable foreign key through idMap.
func remapNullableID(id *int64, idMap map[int64]int64) *int64 {
	if id == nil {
		return nil
	}
	if mapped, ok := idMap[*id]; ok {
		return &mapped
	}
	return nil
}
