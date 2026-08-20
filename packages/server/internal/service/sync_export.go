package service

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/scope"
	"go.uber.org/zap"
	"gorm.io/datatypes"
)

// exportFilenameLayout is the Content-Disposition timestamp layout
// (frozen contract: InkBloom-<YYYYMMDD-HHmm>.inkbloom).
const exportFilenameLayout = "InkBloom-20060102-1504.inkbloom"

// Export writes the user's full dataset as a .inkbloom zip into w and
// returns the suggested download filename. The zip layout is frozen:
// manifest.json at the root + assets/ directory holding every local asset
// file referenced by the exported payloads (rewritten to @@asset: refs).
func (s *SyncService) Export(ctx context.Context, userID int64, w io.Writer) (string, error) {
	nickname := ""
	if user, err := s.userRepo.GetByID(ctx, userID); err != nil {
		return "", fmt.Errorf("load user: %w", err)
	} else if user != nil {
		nickname = user.Nickname
	}

	novels, err := s.listAllUserNovels(ctx, userID)
	if err != nil {
		return "", fmt.Errorf("list novels: %w", err)
	}

	// assetURLs collects every local asset URL referenced by any payload;
	// the referenced files are copied into the package.
	assetURLs := map[string]bool{}

	bundles, err := s.buildNovelBundles(ctx, userID, novels, assetURLs)
	if err != nil {
		return "", err
	}
	media, err := s.buildMediaPayload(ctx, userID, assetURLs)
	if err != nil {
		return "", err
	}
	knowledge, err := s.buildKnowledgePayload(ctx, userID)
	if err != nil {
		return "", err
	}

	manifest := exportManifest{
		App:           "InkBloom",
		FormatVersion: manifestFormatVersion,
		ExportedAt:    time.Now().Format(time.RFC3339),
		Source:        map[string]string{"nickname": nickname},
		Novels:        bundles,
		Media:         media,
		Knowledge:     knowledge,
	}

	zw := zip.NewWriter(w)
	mw, err := zw.Create("manifest.json")
	if err != nil {
		return "", fmt.Errorf("zip manifest entry: %w", err)
	}
	enc := json.NewEncoder(mw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(manifest); err != nil {
		return "", fmt.Errorf("encode manifest: %w", err)
	}

	if err := s.copyAssetsIntoZip(zw, assetURLs); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", fmt.Errorf("close zip: %w", err)
	}
	return time.Now().Format(exportFilenameLayout), nil
}

// buildNovelBundles loads every novel's volumes/chapters/outline/memory and
// the computed rhythm snapshot. Local asset URLs in text payloads are
// collected (the files get copied into the package) and rewritten to
// @@asset:<package path> references per the frozen contract.
func (s *SyncService) buildNovelBundles(ctx context.Context, userID int64, novels []model.Novel, assetURLs map[string]bool) ([]exportNovelBundle, error) {
	bundles := make([]exportNovelBundle, 0, len(novels))
	for _, n := range novels {
		var volumes []model.Volume
		if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
			Where("novel_id = ?", n.ID).Order("position ASC").Find(&volumes).Error; err != nil {
			return nil, fmt.Errorf("load volumes of novel %d: %w", n.ID, err)
		}
		var chapters []model.Chapter
		if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
			Where("novel_id = ?", n.ID).Order("position ASC").Find(&chapters).Error; err != nil {
			return nil, fmt.Errorf("load chapters of novel %d: %w", n.ID, err)
		}

		// Collect + rewrite asset references on novel / chapter fields.
		n.Description = rewritePtrText(n.Description, assetURLs)
		n.CoverImage = rewritePtrText(n.CoverImage, assetURLs)
		n.Metadata = rewriteRawJSON(n.Metadata, assetURLs)
		for i := range chapters {
			chapters[i].Content = rewritePtrText(chapters[i].Content, assetURLs)
			chapters[i].Summary = rewritePtrText(chapters[i].Summary, assetURLs)
			chapters[i].ContentJSON = rewriteRawJSON(chapters[i].ContentJSON, assetURLs)
		}

		bundle := exportNovelBundle{Novel: n, Volumes: volumes, Chapters: chapters, NovelID: n.ID}

		outline, err := s.docRepo.GetOutline(ctx, userID, n.ID)
		if err != nil {
			return nil, fmt.Errorf("load outline of novel %d: %w", n.ID, err)
		}
		if outline.Version > 0 || len(outline.Acts) > 2 {
			bundle.Outline = &exportDocPayload{Items: json.RawMessage(rewriteRawJSON(outline.Acts, assetURLs)), Version: outline.Version}
		}
		memory, err := s.docRepo.GetMemory(ctx, userID, n.ID)
		if err != nil {
			return nil, fmt.Errorf("load memory of novel %d: %w", n.ID, err)
		}
		if memory.Version > 0 || len(memory.Items) > 2 {
			bundle.Memory = &exportDocPayload{Items: json.RawMessage(rewriteRawJSON(memory.Items, assetURLs)), Version: memory.Version}
		}

		// Rhythm is server-derived (never persisted); snapshot it for
		// reference. Import ignores it.
		bundle.Rhythm = computeRhythmPoints(chapters)
		if len(bundle.Rhythm) == 0 {
			bundle.Rhythm = nil
		}
		bundles = append(bundles, bundle)
	}
	return bundles, nil
}

// buildMediaPayload exports media contents / topics / memory.
func (s *SyncService) buildMediaPayload(ctx context.Context, userID int64, assetURLs map[string]bool) (exportMediaPayload, error) {
	var contents []model.MediaContent
	if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Order("position ASC").Find(&contents).Error; err != nil {
		return exportMediaPayload{}, fmt.Errorf("load media contents: %w", err)
	}
	var topics []model.MediaTopic
	if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).
		Order("position ASC").Find(&topics).Error; err != nil {
		return exportMediaPayload{}, fmt.Errorf("load media topics: %w", err)
	}

	payload := exportMediaPayload{Contents: contents, Topics: topics}

	var mem model.MediaMemory
	err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).First(&mem).Error
	if err == nil {
		updatedAt := mem.UpdatedAt
		payload.Memory = &exportDocPayload{
			Items:     json.RawMessage(rewriteRawJSON(mem.Items, assetURLs)),
			Version:   mem.Version,
			UpdatedAt: &updatedAt,
		}
	}
	for i := range contents {
		contents[i].Content = rewriteText(contents[i].Content, assetURLs)
	}
	for i := range topics {
		topics[i].Note = rewriteText(topics[i].Note, assetURLs)
	}
	return payload, nil
}

// buildKnowledgePayload exports every knowledge node/edge of the user.
func (s *SyncService) buildKnowledgePayload(ctx context.Context, userID int64) (exportKnowledgePayload, error) {
	var nodes []model.KnowledgeNode
	if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Find(&nodes).Error; err != nil {
		return exportKnowledgePayload{}, fmt.Errorf("load knowledge nodes: %w", err)
	}
	var edges []model.KnowledgeEdge
	if err := s.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Find(&edges).Error; err != nil {
		return exportKnowledgePayload{}, fmt.Errorf("load knowledge edges: %w", err)
	}
	return exportKnowledgePayload{Nodes: nodes, Edges: edges}, nil
}

// copyAssetsIntoZip copies every referenced local asset file into the
// package under assets/<urlPath>. Missing files are skipped with a warning
// (export must not fail because one generated image was cleaned up).
func (s *SyncService) copyAssetsIntoZip(zw *zip.Writer, assetURLs map[string]bool) error {
	urlPaths := make([]string, 0, len(assetURLs))
	for u := range assetURLs {
		urlPaths = append(urlPaths, u)
	}
	sort.Strings(urlPaths)

	for _, urlPath := range urlPaths {
		clean := strings.TrimPrefix(urlPath, "/assets/files/")
		if clean == "" || clean == urlPath {
			continue
		}
		// Defense in depth: entry names must stay inside the package.
		if strings.Contains(clean, "..") {
			continue
		}
		// The StaticFS route serves /assets/files/* from NovelAssetDir(0)
		// (baseDir/novels), so the url path maps onto that root.
		filePath := filepath.Join(s.fs.NovelAssetDir(0), filepath.FromSlash(clean))
		f, err := os.Open(filePath)
		if err != nil {
			s.logger.Warn("export: referenced asset missing, skipped",
				zap.String("url", urlPath))
			continue
		}
		entry, err := zw.Create("assets/" + clean)
		if err != nil {
			f.Close()
			return fmt.Errorf("zip asset entry %s: %w", clean, err)
		}
		if _, err := io.Copy(entry, f); err != nil {
			f.Close()
			return fmt.Errorf("zip asset copy %s: %w", clean, err)
		}
		f.Close()
	}
	return nil
}

func strPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// rewriteText collects every local asset URL into dst and replaces it with
// the package-relative @@asset: reference (frozen contract).
func rewriteText(text string, dst map[string]bool) string {
	if text == "" {
		return text
	}
	return localAssetURLPattern.ReplaceAllStringFunc(text, func(m string) string {
		dst[m] = true
		return assetRefPrefix + "assets/" + strings.TrimPrefix(m, "/assets/files/")
	})
}

// rewritePtrText applies rewriteText to a nullable text column.
func rewritePtrText(p *string, dst map[string]bool) *string {
	if p == nil {
		return nil
	}
	v := rewriteText(*p, dst)
	return &v
}

// rewriteRawJSON applies rewriteText to an opaque JSON payload.
func rewriteRawJSON(raw datatypes.JSON, dst map[string]bool) datatypes.JSON {
	if len(raw) == 0 {
		return raw
	}
	return datatypes.JSON(rewriteText(string(raw), dst))
}
