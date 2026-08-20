package service

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"gorm.io/gorm"
)

// importMaxBytes caps accepted .inkbloom uploads at 500MB (frozen contract).
const importMaxBytes = 500 << 20

// manifestMaxBytes caps the manifest.json entry (defense against zip bombs).
const manifestMaxBytes = 20 << 20

// conflictCopySuffix marks conflict replicas (frozen contract).
const conflictCopySuffix = "（冲突副本）"

// ImportCreatedKeys are the always-present categories of result.created.
var ImportCreatedKeys = []string{
	"novels", "chapters", "volumes",
	"media_contents", "media_topics", "media_memory",
	"knowledge_nodes", "knowledge_edges", "assets",
}

// Import merges a .inkbloom package into the current user's library.
// The whole database mutation runs in one transaction; asset files copied
// alongside are removed again when the transaction rolls back.
func (s *SyncService) Import(ctx context.Context, userID int64, data []byte) (*ImportResult, error) {
	if int64(len(data)) > importMaxBytes {
		return nil, fmt.Errorf("%w: file exceeds the 500MB limit", ErrImportPackage)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("%w: not a valid zip archive: %v", ErrImportPackage, err)
	}

	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		if err := validateEntryName(f.Name); err != nil {
			return nil, err
		}
		files[f.Name] = f
	}

	manifestFile, ok := files["manifest.json"]
	if !ok {
		return nil, fmt.Errorf("%w: manifest.json not found", ErrImportPackage)
	}
	mr, err := manifestFile.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: open manifest.json: %v", ErrImportPackage, err)
	}
	raw, err := readAllCapped(mr, manifestMaxBytes, "manifest.json")
	mr.Close()
	if err != nil {
		return nil, err
	}
	var manifest importManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("%w: parse manifest.json: %v", ErrImportPackage, err)
	}
	if manifest.App != "InkBloom" {
		return nil, fmt.Errorf("%w: unsupported app %q", ErrImportPackage, manifest.App)
	}
	if manifest.FormatVersion != manifestFormatVersion {
		return nil, fmt.Errorf("%w: unsupported format_version %d", ErrImportPackage, manifest.FormatVersion)
	}

	result := &ImportResult{Created: map[string]int{}}
	for _, k := range ImportCreatedKeys {
		result.Created[k] = 0
	}

	// novelIDMap remaps package novel ids onto current-library novel ids;
	// the knowledge import needs it to attach nodes/edges.
	novelIDMap := map[int64]int64{}

	var writtenFiles []string
	txErr := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.importNovels(ctx, tx, userID, &manifest, files, result, novelIDMap, &writtenFiles); err != nil {
			return err
		}
		if err := s.importMedia(ctx, tx, userID, &manifest, files, result, &writtenFiles); err != nil {
			return err
		}
		return s.importKnowledge(ctx, tx, userID, &manifest, novelIDMap, result)
	})
	if txErr != nil {
		for _, f := range writtenFiles {
			_ = os.Remove(f)
		}
		return nil, txErr
	}
	return result, nil
}

// importNovels merges every package novel following the conflict rules:
// title match → newer updated_at wins → the loser's current state is kept
// as a "（冲突副本）" replica; no match → create.
func (s *SyncService) importNovels(ctx context.Context, tx *gorm.DB, userID int64, m *importManifest, files map[string]*zip.File, result *ImportResult, novelIDMap map[int64]int64, written *[]string) error {
	for i := range m.Novels {
		bundle := &m.Novels[i]
		pkg := bundle.Novel
		if strings.TrimSpace(pkg.Title) == "" {
			return fmt.Errorf("%w: novel with empty title in package", ErrImportPackage)
		}

		var existing model.Novel
		err := tx.Scopes(scope.ForUser(userID)).Where("title = ?", pkg.Title).First(&existing).Error
		if err != nil && err != gorm.ErrRecordNotFound {
			return fmt.Errorf("match novel %q: %w", pkg.Title, err)
		}

		if err == gorm.ErrRecordNotFound {
			newID, err := s.createNovelFromBundle(ctx, tx, userID, bundle, files, result, written)
			if err != nil {
				return err
			}
			novelIDMap[pkg.ID] = newID
			continue
		}

		if !pkg.UpdatedAt.After(existing.UpdatedAt) {
			// Existing is newer (or equal): the whole package bundle is
			// skipped; nothing is deleted.
			result.Skipped++
			novelIDMap[pkg.ID] = existing.ID
			continue
		}

		// Package wins: snapshot the current state as a conflict replica
		// first, then overwrite in place.
		if err := s.snapshotConflictCopy(ctx, tx, userID, existing); err != nil {
			return err
		}
		result.Conflicts++
		if err := s.overwriteNovelFromBundle(ctx, tx, userID, existing, bundle, files, result, written); err != nil {
			return err
		}
		novelIDMap[pkg.ID] = existing.ID
	}
	return nil
}

// createNovelFromBundle inserts a brand-new novel with its volumes,
// chapters and documents; returns the new novel id.
func (s *SyncService) createNovelFromBundle(ctx context.Context, tx *gorm.DB, userID int64, bundle *importManifestNovel, files map[string]*zip.File, result *ImportResult, written *[]string) (int64, error) {
	novel := bundle.Novel
	novel.ID = 0
	novel.UserID = userID
	novel.DeletedAt = gorm.DeletedAt{}
	if err := tx.Create(&novel).Error; err != nil {
		return 0, fmt.Errorf("create novel %q: %w", novel.Title, err)
	}
	result.Created["novels"]++

	volIDMap := map[int64]int64{}
	for i := range bundle.Volumes {
		v := bundle.Volumes[i]
		v.ID, v.NovelID, v.UserID = 0, novel.ID, userID
		if err := tx.Create(&v).Error; err != nil {
			return 0, fmt.Errorf("create volume %q: %w", v.Title, err)
		}
		volIDMap[bundle.Volumes[i].ID] = v.ID
		result.Created["volumes"]++
	}

	for i := range bundle.Chapters {
		ch := bundle.Chapters[i]
		ch.ID, ch.NovelID, ch.UserID = 0, novel.ID, userID
		ch.VolumeID = remapNullableID(ch.VolumeID, volIDMap)
		ch.Position = i
		if err := s.importChapterAssets(&ch, novel.ID, files, result, written); err != nil {
			return 0, err
		}
		if err := tx.Create(&ch).Error; err != nil {
			return 0, fmt.Errorf("create chapter %q: %w", ch.Title, err)
		}
		result.Created["chapters"]++
	}

	// Novel fields may also reference assets (cover image).
	if bundle.Novel.CoverImage != nil {
		newURL, err := s.copyPackageAsset(files, strPtr(bundle.Novel.CoverImage), novel.ID, result, written)
		if err != nil {
			return 0, err
		}
		if newURL != "" {
			tx.Model(&model.Novel{}).Where("id = ?", novel.ID).Update("cover_image", newURL)
		}
	}

	if err := s.upsertImportedDocs(ctx, tx, userID, novel.ID, bundle, files, result, written); err != nil {
		return 0, err
	}
	s.recomputeWordCount(tx, userID, novel.ID)
	return novel.ID, nil
}

// overwriteNovelFromBundle applies a winning package bundle onto the
// matched novel: novel fields are replaced, chapters merged by title
// (newer chapter wins, extras appended), volumes matched by title, and
// outline/memory wholesale-replaced.
func (s *SyncService) overwriteNovelFromBundle(ctx context.Context, tx *gorm.DB, userID int64, existing model.Novel, bundle *importManifestNovel, files map[string]*zip.File, result *ImportResult, written *[]string) error {
	pkg := bundle.Novel
	updates := map[string]interface{}{
		"genre":       pkg.Genre,
		"description": pkg.Description,
		"status":      pkg.Status,
		"metadata":    pkg.Metadata,
		"word_count":  pkg.WordCount,
		"updated_at":  time.Now(),
	}
	if pkg.CoverImage != nil {
		if existing.CoverImage != nil && *existing.CoverImage != "" {
			// The matched novel already owns a cover (its own uploaded or
			// previously imported file): keep it instead of copying the
			// package file again — re-imports must stay idempotent.
			updates["cover_image"] = existing.CoverImage
		} else {
			newURL, err := s.copyPackageAsset(files, strPtr(pkg.CoverImage), existing.ID, result, written)
			if err != nil {
				return err
			}
			if newURL != "" {
				updates["cover_image"] = newURL
			} else {
				updates["cover_image"] = pkg.CoverImage
			}
		}
	}
	if err := tx.Model(&model.Novel{}).Where("id = ? AND user_id = ?", existing.ID, userID).Updates(updates).Error; err != nil {
		return fmt.Errorf("overwrite novel %d: %w", existing.ID, err)
	}
	result.Updated++

	// Volumes: match by title, create the extras.
	var existingVols []model.Volume
	if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", existing.ID).Find(&existingVols).Error; err != nil {
		return err
	}
	volByTitle := map[string]int64{}
	for _, v := range existingVols {
		volByTitle[v.Title] = v.ID
	}
	volIDMap := map[int64]int64{}
	for i := range bundle.Volumes {
		pv := bundle.Volumes[i]
		if id, ok := volByTitle[pv.Title]; ok {
			volIDMap[pv.ID] = id
			continue
		}
		v := model.Volume{UserID: userID, NovelID: existing.ID, Title: pv.Title, Position: pv.Position}
		if err := tx.Create(&v).Error; err != nil {
			return err
		}
		volIDMap[pv.ID] = v.ID
		result.Created["volumes"]++
	}

	// Chapters: match by title.
	var existingChs []model.Chapter
	if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", existing.ID).Order("position ASC").Find(&existingChs).Error; err != nil {
		return err
	}
	chByTitle := map[string]*model.Chapter{}
	for i := range existingChs {
		chByTitle[existingChs[i].Title] = &existingChs[i]
	}
	maxPos := 0
	for _, c := range existingChs {
		if c.Position > maxPos {
			maxPos = c.Position
		}
	}

	for i := range bundle.Chapters {
		pc := bundle.Chapters[i]
		if err := s.importChapterAssets(&pc, existing.ID, files, result, written); err != nil {
			return err
		}
		if cur, ok := chByTitle[pc.Title]; ok {
			if pc.UpdatedAt.After(cur.UpdatedAt) {
				if err := tx.Model(&model.Chapter{}).Where("id = ? AND user_id = ?", cur.ID, userID).Updates(map[string]interface{}{
					"content":      pc.Content,
					"content_json": pc.ContentJSON,
					"word_count":   pc.WordCount,
					"summary":      pc.Summary,
					"status":       pc.Status,
					"updated_at":   time.Now(),
				}).Error; err != nil {
					return err
				}
				result.Updated++
			} else {
				result.Skipped++
			}
			continue
		}
		maxPos++
		ch := model.Chapter{
			UserID: userID, NovelID: existing.ID,
			VolumeID: remapNullableID(pc.VolumeID, volIDMap),
			Title:    pc.Title, Content: pc.Content, ContentJSON: pc.ContentJSON,
			WordCount: pc.WordCount, Position: maxPos, Summary: pc.Summary, Status: pc.Status,
		}
		if err := tx.Create(&ch).Error; err != nil {
			return err
		}
		result.Created["chapters"]++
	}

	if err := s.upsertImportedDocs(ctx, tx, userID, existing.ID, bundle, files, result, written); err != nil {
		return err
	}
	s.recomputeWordCount(tx, userID, existing.ID)
	return nil
}

// snapshotConflictCopy replicates the current state of a novel (novel row +
// volumes + chapters + outline/memory) as a standalone conflict replica.
func (s *SyncService) snapshotConflictCopy(ctx context.Context, tx *gorm.DB, userID int64, existing model.Novel) error {
	replica := existing
	replica.ID = 0
	replica.Title = existing.Title + conflictCopySuffix
	replica.DeletedAt = gorm.DeletedAt{}
	if err := tx.Create(&replica).Error; err != nil {
		return fmt.Errorf("create conflict replica of %q: %w", existing.Title, err)
	}

	var vols []model.Volume
	if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", existing.ID).Order("position ASC").Find(&vols).Error; err != nil {
		return err
	}
	volIDMap := map[int64]int64{}
	for i := range vols {
		old := vols[i].ID
		v := vols[i]
		v.ID, v.NovelID = 0, replica.ID
		if err := tx.Create(&v).Error; err != nil {
			return err
		}
		volIDMap[old] = v.ID
	}

	var chs []model.Chapter
	if err := tx.Scopes(scope.ForUser(userID)).Where("novel_id = ?", existing.ID).Order("position ASC").Find(&chs).Error; err != nil {
		return err
	}
	for i := range chs {
		c := chs[i]
		c.ID, c.NovelID = 0, replica.ID
		c.VolumeID = remapNullableID(c.VolumeID, volIDMap)
		c.DeletedAt = gorm.DeletedAt{}
		if err := tx.Create(&c).Error; err != nil {
			return err
		}
	}

	var outline model.NovelOutline
	if err := tx.Where("novel_id = ? AND user_id = ?", existing.ID, userID).First(&outline).Error; err == nil {
		outline.NovelID = replica.ID
		if err := tx.Create(&outline).Error; err != nil {
			return err
		}
	}
	var mem model.NovelMemory
	if err := tx.Where("novel_id = ? AND user_id = ?", existing.ID, userID).First(&mem).Error; err == nil {
		mem.NovelID = replica.ID
		if err := tx.Create(&mem).Error; err != nil {
			return err
		}
	}
	return nil
}

// upsertImportedDocs writes the package outline/memory documents of one
// novel, rewriting embedded asset references first.
func (s *SyncService) upsertImportedDocs(ctx context.Context, tx *gorm.DB, userID, novelID int64, bundle *importManifestNovel, files map[string]*zip.File, result *ImportResult, written *[]string) error {
	if bundle.Outline != nil && len(bundle.Outline.Items) > 0 {
		items, err := s.rewriteRawAssetRefs(bundle.Outline.Items, novelID, files, result, written)
		if err != nil {
			return err
		}
		doc := &model.NovelOutline{NovelID: novelID, UserID: userID, Acts: items}
		if err := s.upsertOutlineInTx(tx, doc); err != nil {
			return fmt.Errorf("upsert outline of novel %d: %w", novelID, err)
		}
	}
	if bundle.Memory != nil && len(bundle.Memory.Items) > 0 {
		items, err := s.rewriteRawAssetRefs(bundle.Memory.Items, novelID, files, result, written)
		if err != nil {
			return err
		}
		doc := &model.NovelMemory{NovelID: novelID, UserID: userID, Items: items}
		if err := s.upsertMemoryInTx(tx, doc); err != nil {
			return fmt.Errorf("upsert memory of novel %d: %w", novelID, err)
		}
	}
	return nil
}

// upsertOutlineInTx / upsertMemoryInTx write the novel documents on the
// import transaction handle itself. The document repository is bound to the
// root pool; using it here would grab a second connection and deadlock
// against the open write transaction (SQLite reports SQLITE_BUSY).
func (s *SyncService) upsertOutlineInTx(tx *gorm.DB, doc *model.NovelOutline) error {
	var cur model.NovelOutline
	err := tx.Where("novel_id = ? AND user_id = ?", doc.NovelID, doc.UserID).First(&cur).Error
	if err == nil {
		return tx.Model(&model.NovelOutline{}).Where("novel_id = ?", doc.NovelID).Updates(map[string]interface{}{
			"acts":       doc.Acts,
			"version":    cur.Version + 1,
			"updated_at": time.Now(),
		}).Error
	}
	if err != gorm.ErrRecordNotFound {
		return err
	}
	if doc.Version <= 0 {
		doc.Version = 1
	}
	return tx.Create(doc).Error
}

func (s *SyncService) upsertMemoryInTx(tx *gorm.DB, doc *model.NovelMemory) error {
	var cur model.NovelMemory
	err := tx.Where("novel_id = ? AND user_id = ?", doc.NovelID, doc.UserID).First(&cur).Error
	if err == nil {
		return tx.Model(&model.NovelMemory{}).Where("novel_id = ?", doc.NovelID).Updates(map[string]interface{}{
			"items":      doc.Items,
			"version":    cur.Version + 1,
			"updated_at": time.Now(),
		}).Error
	}
	if err != gorm.ErrRecordNotFound {
		return err
	}
	if doc.Version <= 0 {
		doc.Version = 1
	}
	return tx.Create(doc).Error
}

// importChapterAssets copies the chapter's @@asset-referenced files into
// the storage root and rewrites content/summary to the fresh URLs.
func (s *SyncService) importChapterAssets(ch *model.Chapter, novelID int64, files map[string]*zip.File, result *ImportResult, written *[]string) error {
	if ch.Content != nil {
		newText, err := s.rewriteTextAssetRefs(*ch.Content, novelID, files, result, written)
		if err != nil {
			return err
		}
		ch.Content = &newText
	}
	if ch.Summary != nil {
		newText, err := s.rewriteTextAssetRefs(*ch.Summary, novelID, files, result, written)
		if err != nil {
			return err
		}
		ch.Summary = &newText
	}
	if len(ch.ContentJSON) > 0 {
		rewritten, err := s.rewriteRawAssetRefs(ch.ContentJSON, novelID, files, result, written)
		if err != nil {
			return err
		}
		ch.ContentJSON = rewritten
	}
	return nil
}
