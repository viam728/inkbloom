package storage

import (
	"fmt"
	"os"
	"path/filepath"
)

// FileStorage manages local file system paths for generated assets.
type FileStorage struct {
	baseDir string
}

// NewFileStorage creates a FileStorage rooted at ~/.inkbloom.
func NewFileStorage() *FileStorage {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	base := filepath.Join(home, ".inkbloom")
	return &FileStorage{baseDir: base}
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
