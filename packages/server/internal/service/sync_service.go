// Package service: sync_service.go implements the M5 .inkbloom data
// export/import feature (task #47). The export packs the current user's
// full dataset into a zip stream (manifest.json + assets/ directory); the
// import merges such a package back under the importing user following the
// frozen frontend contract (title match → newer updated_at wins → loser kept
// as a "（冲突副本）" replica).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/storage"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// manifestFormatVersion is the only accepted .inkbloom format version.
const manifestFormatVersion = 1

// ErrImportPackage is returned for every package-level validation failure
// (bad zip, wrong manifest, unsupported version). The handler maps it to 400.
var ErrImportPackage = errors.New("invalid .inkbloom package")

// assetRefPrefix marks package-relative asset references inside exported
// text payloads: @@asset:<path inside the package, e.g. assets/3/...>.
const assetRefPrefix = "@@asset:"

// assetRefPattern matches @@asset:<non-whitespace path> tokens in text.
var assetRefPattern = regexp.MustCompile(`@@asset:([^\s"'\)\]<>]+)`)

// localAssetURLPattern matches local server asset URLs embedded in content
// (served from the storage root via StaticFS /assets/files/*).
var localAssetURLPattern = regexp.MustCompile(`/assets/files/[^\s"'\)\]<>]+`)

// exportNovelBundle is one novel entry of the manifest plus its computed
// rhythm snapshot (server-derived, stored nowhere).
type exportNovelBundle struct {
	Novel    model.Novel       `json:"novel"`
	Volumes  []model.Volume    `json:"volumes"`
	Chapters []model.Chapter   `json:"chapters"`
	Outline  *exportDocPayload `json:"outline"`
	Memory   *exportDocPayload `json:"memory"`
	Rhythm   []RhythmPoint     `json:"rhythm"`
	NovelID  int64             `json:"-"`
}

// exportDocPayload mirrors the GET outline/memory response shape
// ({ items, version }) with the payload kept opaque. UpdatedAt is an
// additive field used only for media memory conflict comparison.
type exportDocPayload struct {
	Items     json.RawMessage `json:"items"`
	Version   int             `json:"version"`
	UpdatedAt *time.Time      `json:"updated_at,omitempty"`
}

type exportMediaPayload struct {
	Contents []model.MediaContent `json:"contents"`
	Topics   []model.MediaTopic   `json:"topics"`
	Memory   *exportDocPayload    `json:"memory"`
}

type exportKnowledgePayload struct {
	Nodes []model.KnowledgeNode `json:"nodes"`
	Edges []model.KnowledgeEdge `json:"edges"`
}

// exportManifest is the root manifest.json shape (frozen contract).
type exportManifest struct {
	App           string                 `json:"app"`
	FormatVersion int                    `json:"format_version"`
	ExportedAt    string                 `json:"exported_at"`
	Source        map[string]string      `json:"source"`
	Novels        []exportNovelBundle    `json:"novels"`
	Media         exportMediaPayload     `json:"media"`
	Knowledge     exportKnowledgePayload `json:"knowledge"`
}

// importManifest is the tolerant parse target: opaque JSON payloads are
// preserved as raw messages so unknown future fields survive the round-trip.
type importManifest struct {
	App           string `json:"app"`
	FormatVersion int    `json:"format_version"`
	ExportedAt    string `json:"exported_at"`

	Novels []importManifestNovel `json:"novels"`

	Media struct {
		Contents []model.MediaContent `json:"contents"`
		Topics   []model.MediaTopic   `json:"topics"`
		Memory   *importDocPayload    `json:"memory"`
	} `json:"media"`

	Knowledge struct {
		Nodes []model.KnowledgeNode `json:"nodes"`
		Edges []model.KnowledgeEdge `json:"edges"`
	} `json:"knowledge"`
}

// importManifestNovel is one novel entry of the manifest.
type importManifestNovel struct {
	Novel    model.Novel       `json:"novel"`
	Volumes  []model.Volume    `json:"volumes"`
	Chapters []model.Chapter   `json:"chapters"`
	Outline  *importDocPayload `json:"outline"`
	Memory   *importDocPayload `json:"memory"`
	Rhythm   json.RawMessage   `json:"rhythm"`
}

type importDocPayload struct {
	Items     json.RawMessage `json:"items"`
	Version   int             `json:"version"`
	UpdatedAt *time.Time      `json:"updated_at"`
}

// ImportResult is the POST /sync/import response payload (frozen contract).
type ImportResult struct {
	Created   map[string]int `json:"created"`
	Updated   int            `json:"updated"`
	Conflicts int            `json:"conflicts"`
	Skipped   int            `json:"skipped"`
	Message   string         `json:"message,omitempty"`
}

// SyncService implements .inkbloom export/import. Reads reuse the existing
// repositories; the import's transactional bulk writes go through the shared
// *gorm.DB. Asset files live under the injected FileStorage root.
type SyncService struct {
	db        *gorm.DB
	fs        *storage.FileStorage
	novelRepo repository.NovelRepository
	docRepo   repository.NovelDocRepository
	userRepo  repository.UserRepository
	logger    *zap.Logger
}

// NewSyncService wires a new SyncService.
func NewSyncService(db *gorm.DB, fs *storage.FileStorage, novelRepo repository.NovelRepository, docRepo repository.NovelDocRepository, userRepo repository.UserRepository, logger *zap.Logger) *SyncService {
	return &SyncService{db: db, fs: fs, novelRepo: novelRepo, docRepo: docRepo, userRepo: userRepo, logger: logger}
}

// validateEntryName rejects zip entry names that could escape the package
// (absolute paths or .. segments) before any file is opened.
func validateEntryName(name string) error {
	if strings.HasPrefix(name, "/") || strings.Contains(name, `\`) {
		return fmt.Errorf("%w: illegal entry name %q", ErrImportPackage, name)
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return fmt.Errorf("%w: path traversal in entry %q", ErrImportPackage, name)
		}
	}
	return nil
}

// readAllCapped reads at most max bytes from r; exceeding it is an error.
func readAllCapped(r io.Reader, max int, what string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read %s: %v", ErrImportPackage, what, err)
	}
	if len(data) > max {
		return nil, fmt.Errorf("%w: %s exceeds the %d byte limit", ErrImportPackage, what, max)
	}
	return data, nil
}

// listAllUserNovels pages through the user's novels via the repository
// (soft-deleted rows are excluded by GORM defaults).
func (s *SyncService) listAllUserNovels(ctx context.Context, userID int64) ([]model.Novel, error) {
	const page = 500
	var all []model.Novel
	for offset := 0; ; offset += page {
		batch, _, err := s.novelRepo.List(ctx, userID, offset, page)
		if err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < page {
			return all, nil
		}
	}
}
