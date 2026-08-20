package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Gallery scope constants (mirror model.AssetScope* but kept here so the
// storage package stays free of internal/model imports).
const (
	GalleryScopeNovel = "novel"
	GalleryScopeMedia = "media"
	GalleryScopeMemo  = "memo"
)

// Provider abstracts the filesystem operations used by asset services.
// Everything goes through the injected FileStorage so no call site ever
// hard-codes a home directory (task #57).
type Provider interface {
	BaseDir() string
	EnsureDir(path string) error
	SaveFile(dst string, r io.Reader) (int64, error)
	Exists(path string) bool
	DeleteFile(path string) error
}

var _ Provider = (*FileStorage)(nil)

// FileStorage manages local file system paths for generated assets.
type FileStorage struct {
	baseDir string
}

// NewFileStorage creates a FileStorage rooted at ~/.inkbloom (cloud mode
// default; unchanged legacy behavior).
func NewFileStorage() *FileStorage {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return NewFileStorageAt(filepath.Join(home, ".inkbloom"))
}

// NewFileStorageAt creates a FileStorage rooted at the given directory
// (task #37: local mode points this at the configurable data root).
func NewFileStorageAt(baseDir string) *FileStorage {
	return &FileStorage{baseDir: baseDir}
}

// BaseDir returns the root storage directory.
func (s *FileStorage) BaseDir() string {
	return s.baseDir
}

// NovelAssetDir returns the asset directory for a given novel.
// If novelID is 0, returns the base novels directory.
func (s *FileStorage) NovelAssetDir(novelID int64) string {
	if novelID == 0 {
		return filepath.Join(s.baseDir, "novels")
	}
	return filepath.Join(s.baseDir, "novels", fmt.Sprintf("%d", novelID), "assets")
}

// EnsureDir creates the directory (and parents) if it does not exist.
func (s *FileStorage) EnsureDir(path string) error {
	return os.MkdirAll(path, 0o755)
}

// SaveFile copies r into dst (parent directory must exist), returning the
// number of bytes written. An existing file is overwritten.
func (s *FileStorage) SaveFile(dst string, r io.Reader) (int64, error) {
	f, err := os.Create(dst)
	if err != nil {
		return 0, fmt.Errorf("create %s: %w", dst, err)
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return n, fmt.Errorf("write %s: %w", dst, err)
	}
	return n, nil
}

// Exists reports whether path points to an existing file.
func (s *FileStorage) Exists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// DeleteFile removes path; a missing file is not an error.
func (s *FileStorage) DeleteFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s: %w", path, err)
	}
	return nil
}

// GalleryDir returns the archive directory for gallery images of the given
// scope (task #57). All directories live under the StaticFS root
// ({base}/novels) so files are directly servable via /assets/files/*:
//
//	novel -> {base}/novels/{novel_id}/assets/gallery
//	media -> {base}/novels/_media/gallery
//	memo  -> {base}/novels/_memo/gallery
func (s *FileStorage) GalleryDir(scope string, novelID int64) string {
	switch scope {
	case GalleryScopeMedia:
		return filepath.Join(s.NovelAssetDir(0), "_media", "gallery")
	case GalleryScopeMemo:
		return filepath.Join(s.NovelAssetDir(0), "_memo", "gallery")
	default: // novel
		return filepath.Join(s.NovelAssetDir(novelID), "gallery")
	}
}

// GalleryURLPrefix returns the public URL prefix (relative to the
// /assets/files static mount) matching GalleryDir.
func (s *FileStorage) GalleryURLPrefix(scope string, novelID int64) string {
	switch scope {
	case GalleryScopeMedia:
		return "/assets/files/_media/gallery"
	case GalleryScopeMemo:
		return "/assets/files/_memo/gallery"
	default: // novel
		if novelID == 0 {
			return "/assets/files/gallery"
		}
		return fmt.Sprintf("/assets/files/%d/assets/gallery", novelID)
	}
}

// AbsFromURL converts a /assets/files/... relative URL back to an absolute
// path under the StaticFS root. Non-asset URLs return "".
func (s *FileStorage) AbsFromURL(url string) string {
	const prefix = "/assets/files/"
	if len(url) <= len(prefix) || url[:len(prefix)] != prefix {
		return ""
	}
	return filepath.Join(s.NovelAssetDir(0), filepath.FromSlash(url[len(prefix):]))
}
