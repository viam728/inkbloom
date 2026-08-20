package service

import (
	"os"
	"path/filepath"
	"sort"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/dto"
)

// ServerVersion is the public server version string served by
// GET /api/v1/public/flags (task #51, M6).
const ServerVersion = "0.6.0"

// PublicService serves the anonymous public endpoints: rollout feature
// flags and the desktop installer download (task #51, M6).
type PublicService struct {
	rollout config.RolloutConfig
	desktop config.DesktopConfig
}

// NewPublicService creates a PublicService from the loaded configuration.
func NewPublicService(rollout config.RolloutConfig, desktop config.DesktopConfig) *PublicService {
	return &PublicService{rollout: rollout, desktop: desktop}
}

// Flags builds the feature-flag payload. uid is nil for anonymous callers;
// authenticated callers additionally receive the per-user enabled switch
// (uid % 100 < rollout.percent).
func (s *PublicService) Flags(uid *int64) *dto.PublicFlags {
	features := s.rollout.Features
	if features == nil {
		features = map[string]bool{}
	}
	out := &dto.PublicFlags{
		Features:       features,
		RolloutPercent: s.rollout.Percent,
		ServerVersion:  ServerVersion,
	}
	// Min desktop client version floor (v2 §7.1): env-driven so ops can
	// raise it without a redeploy (INKBLOOM_DESKTOP_MIN_VERSION).
	if v := os.Getenv("INKBLOOM_DESKTOP_MIN_VERSION"); v != "" {
		out.MinDesktopVersion = v
	}
	if uid != nil {
		enabled := *uid%100 < int64(s.rollout.Percent)
		out.Enabled = &enabled
	}
	return out
}

// DesktopInstaller resolves the installer file to stream. Lookup order:
//  1. desktop.installer_path set: file → used directly; directory → first
//     *.exe inside (sorted by name); anything else → not found;
//  2. unset: scan ../desktop/dist (repo layout, cwd=packages/server) then
//     packages/desktop/dist (cwd=repo root) for the first *.exe.
func (s *PublicService) DesktopInstaller() (string, bool) {
	if p := s.desktop.InstallerPath; p != "" {
		return resolveInstallerPath(p)
	}
	for _, dir := range []string{"../desktop/dist", "packages/desktop/dist"} {
		if path, ok := resolveInstallerPath(dir); ok {
			return path, true
		}
	}
	return "", false
}

// resolveInstallerPath resolves one candidate path (file or directory).
func resolveInstallerPath(p string) (string, bool) {
	info, err := os.Stat(p)
	if err != nil {
		return "", false
	}
	if !info.IsDir() {
		return p, true
	}
	matches, err := filepath.Glob(filepath.Join(p, "*.exe"))
	if err != nil || len(matches) == 0 {
		return "", false
	}
	sort.Strings(matches)
	return matches[0], true
}
