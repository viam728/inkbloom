package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/storage"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// Gallery ingest tunables (task #57).
const (
	// galleryThumbSize is the long-side target for generated thumbnails.
	galleryThumbSize = 256
	// galleryThumbQuality is the JPEG quality of thumbnail bytes.
	galleryThumbQuality = 80
)

// Sentinel errors surfaced by ImageService and mapped to HTTP codes by the
// handler (404 / 409).
var (
	ErrImageNotFound     = errors.New("image not found")
	ErrImageReferenced   = errors.New("image still referenced by content")
	ErrImageCursorFormat = errors.New("invalid cursor")
)

// IngestMeta describes an incoming gallery upload.
type IngestMeta struct {
	UserID    int64
	Scope     string // novel | media | memo (already normalized by handler)
	NovelID   int64  // 0 when absent
	Source    string // "upload" | "ai"
	Extension string // includes the dot, e.g. ".png"
}

// ImageService implements the gallery ingest/list/delete pipeline.
type ImageService struct {
	assetRepo repository.AssetRepository
	fs        *storage.FileStorage
	logger    *zap.Logger
}

// NewImageService creates an ImageService backed by the injected storage.
func NewImageService(assetRepo repository.AssetRepository, fs *storage.FileStorage, logger *zap.Logger) *ImageService {
	return &ImageService{assetRepo: assetRepo, fs: fs, logger: logger}
}

// Ingest streams r to disk in a single pass, dedupes by sha256 per user and
// archives the file into the scope gallery directory. It returns the asset
// record and whether an existing record was reused (deduplicated).
func (s *ImageService) Ingest(ctx context.Context, r io.Reader, meta IngestMeta) (*model.Asset, bool, error) {
	dir := s.fs.GalleryDir(meta.Scope, meta.UserID, meta.NovelID)
	thumbDir := filepath.Join(dir, "thumbs")
	if err := s.fs.EnsureDir(dir); err != nil {
		return nil, false, fmt.Errorf("create gallery dir: %w", err)
	}
	if err := s.fs.EnsureDir(thumbDir); err != nil {
		return nil, false, fmt.Errorf("create thumb dir: %w", err)
	}

	// Temp file lives in the archive directory itself so the final
	// os.Rename stays atomic (same volume).
	tmp, err := os.CreateTemp(dir, ".upload-*.tmp")
	if err != nil {
		return nil, false, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		tmp.Close()
		_ = os.Remove(tmpPath)
	}

	// Single pass: bytes flow into the temp file and the hasher together.
	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hasher), r)
	if err != nil {
		cleanup()
		return nil, false, fmt.Errorf("write upload: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return nil, false, fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return nil, false, fmt.Errorf("close temp file: %w", err)
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	// Dedupe: (user_id, content_hash) is unique; reuse the existing record.
	if existing, err := s.assetRepo.FindByUserHash(ctx, meta.UserID, hash); err == nil && existing != nil {
		_ = os.Remove(tmpPath)
		return existing, true, nil
	}

	// Decode for dimensions + thumbnail. Decoders cover jpeg/png/gif/bmp/tiff;
	// webp uploads keep full bytes but skip the thumbnail gracefully.
	width, height := 0, 0
	var thumb image.Image
	if f, derr := os.Open(tmpPath); derr == nil {
		if img, ierr := imaging.Decode(f); ierr == nil {
			b := img.Bounds()
			width, height = b.Dx(), b.Dy()
			thumb = galleryResize(img, galleryThumbSize)
		} else {
			s.logger.Warn("gallery image decode failed (stored without thumbnail)",
				zap.String("hash", hash), zap.Error(ierr))
		}
		_ = f.Close()
	}

	// Archive: {dir}/{hash[:2]}/{hash}{ext}, atomically renamed.
	shardDir := filepath.Join(dir, hash[:2])
	if err := s.fs.EnsureDir(shardDir); err != nil {
		_ = os.Remove(tmpPath)
		return nil, false, fmt.Errorf("create shard dir: %w", err)
	}
	finalPath := filepath.Join(shardDir, hash+meta.Extension)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return nil, false, fmt.Errorf("archive upload: %w", err)
	}

	// Thumbnail: JPEG bytes at thumbs/{hash}.webp (the imaging library has
	// no webp encoder; the static handler sniffs the real content type).
	thumbURL := ""
	if thumb != nil {
		thumbPath := filepath.Join(thumbDir, hash+".webp")
		if tf, terr := os.Create(thumbPath); terr == nil {
			if eerr := jpeg.Encode(tf, thumb, &jpeg.Options{Quality: galleryThumbQuality}); eerr != nil {
				s.logger.Warn("gallery thumbnail encode failed", zap.String("hash", hash), zap.Error(eerr))
			}
			_ = tf.Close()
		}
	}

	urlPrefix := s.fs.GalleryURLPrefix(meta.Scope, meta.UserID, meta.NovelID)
	url := fmt.Sprintf("%s/%s/%s%s", urlPrefix, hash[:2], hash, meta.Extension)

	displayName := time.Now().Format("20060102_150405") + meta.Extension
	if thumb != nil {
		thumbURL = fmt.Sprintf("%s/thumbs/%s.webp", urlPrefix, hash)
	}

	var novelID *int64
	if meta.NovelID > 0 {
		novelID = &meta.NovelID
	}
	asset := &model.Asset{
		UserID:        meta.UserID,
		NovelID:       novelID,
		FilePath:      url,
		ThumbnailPath: thumbURL,
		Provider:      meta.Source,
		Width:         int32(width),
		Height:        int32(height),
		FileSize:      int32(n),
		ContentHash:   hash,
		DisplayName:   displayName,
		Scope:         meta.Scope,
		Source:        meta.Source,
	}
	if err := s.assetRepo.Create(ctx, asset); err != nil {
		// Race resolution (task #62): a concurrent upload of identical
		// content may have won the unique-index insert between our
		// FindByUserHash probe and this Create. Re-check before any
		// cleanup — the archived file and thumbnail at these exact
		// deterministic paths now belong to the winning record, so they
		// must NOT be removed (deleting them would orphan the winner).
		if existing, ferr := s.assetRepo.FindByUserHash(ctx, meta.UserID, hash); ferr == nil && existing != nil {
			return existing, true, nil
		}
		_ = os.Remove(finalPath)
		return nil, false, fmt.Errorf("persist asset: %w", err)
	}
	return asset, false, nil
}

// List returns one gallery page (keyset cursor over created_at DESC, id DESC).
func (s *ImageService) List(ctx context.Context, userID int64, scope string, novelID *int64, limit int, cursor string) ([]model.Asset, string, error) {
	var cursorTime *time.Time
	var cursorID int64
	if cursor != "" {
		ct, cid, err := decodeGalleryCursor(cursor)
		if err != nil {
			return nil, "", ErrImageCursorFormat
		}
		cursorTime, cursorID = &ct, cid
	}
	assets, err := s.assetRepo.ListByScope(ctx, userID, scope, novelID, limit, cursorTime, cursorID)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(assets) == limit {
		last := assets[len(assets)-1]
		next = encodeGalleryCursor(last.CreatedAt, last.ID)
	}
	return assets, next, nil
}

// Delete removes one gallery image. Referenced images are rejected unless
// force is set. File removal failures only warn, never block the delete.
func (s *ImageService) Delete(ctx context.Context, userID, id int64, force bool) error {
	asset, err := s.assetRepo.GetByUserAndID(ctx, userID, id)
	if err != nil {
		if repository.IsNotFound(err) {
			return ErrImageNotFound
		}
		return err
	}
	if !force {
		refs, err := s.assetRepo.CountContentReferences(ctx, userID, asset.FilePath)
		if err != nil {
			return err
		}
		if refs > 0 {
			return ErrImageReferenced
		}
	}
	if err := s.assetRepo.Delete(ctx, userID, id); err != nil {
		return err
	}
	s.removeFiles(asset)
	return nil
}

// BatchDelete removes many images; referenced ones land in skipped instead
// of failing the whole batch (no force semantics here).
func (s *ImageService) BatchDelete(ctx context.Context, userID int64, ids []int64) (int, []int64, error) {
	deleted := 0
	skipped := make([]int64, 0)
	for _, id := range ids {
		asset, err := s.assetRepo.GetByUserAndID(ctx, userID, id)
		if err != nil {
			if repository.IsNotFound(err) {
				continue // already gone: silently skip
			}
			return deleted, skipped, err
		}
		refs, err := s.assetRepo.CountContentReferences(ctx, userID, asset.FilePath)
		if err != nil {
			return deleted, skipped, err
		}
		if refs > 0 {
			skipped = append(skipped, id)
			continue
		}
		if err := s.assetRepo.Delete(ctx, userID, id); err != nil {
			return deleted, skipped, err
		}
		s.removeFiles(asset)
		deleted++
	}
	return deleted, skipped, nil
}

// removeFiles best-effort removes the archived bytes + thumbnail.
func (s *ImageService) removeFiles(asset *model.Asset) {
	if p := s.fs.AbsFromURL(asset.FilePath); p != "" {
		if err := s.fs.DeleteFile(p); err != nil {
			s.logger.Warn("gallery file removal failed", zap.String("path", p), zap.Error(err))
		}
	}
	if asset.ThumbnailPath != "" {
		if p := s.fs.AbsFromURL(asset.ThumbnailPath); p != "" {
			if err := s.fs.DeleteFile(p); err != nil {
				s.logger.Warn("gallery thumbnail removal failed", zap.String("path", p), zap.Error(err))
			}
		}
	}
}

// galleryResize scales img down so its longest side is at most maxSide.
func galleryResize(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxSide && h <= maxSide {
		return img
	}
	if w >= h {
		return imaging.Resize(img, maxSide, 0, imaging.Lanczos)
	}
	return imaging.Resize(img, 0, maxSide, imaging.Lanczos)
}

// encodeGalleryCursor packs (created_at, id) into an opaque base64 cursor.
func encodeGalleryCursor(t time.Time, id int64) string {
	raw := t.UTC().Format(time.RFC3339Nano) + "|" + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeGalleryCursor is the inverse of encodeGalleryCursor.
func decodeGalleryCursor(cursor string) (time.Time, int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, 0, err
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, 0, fmt.Errorf("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, 0, err
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return time.Time{}, 0, err
	}
	return t, id, nil
}
