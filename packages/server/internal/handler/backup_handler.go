package handler

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// BackupHandler provides the local-mode SQLite checkpoint endpoint used by
// the Electron desktop shell (task #38, M2-b). It is wired ONLY in local
// embedded mode: the listener is loopback-bound and the data root is
// machine-local, so the endpoint intentionally skips JWT auth (the desktop
// main process must be able to snapshot the DB before any user logs in).
// Cloud mode never registers these routes.
type BackupHandler struct {
	db       *gorm.DB
	dataRoot string
	logger   *zap.Logger
}

// NewBackupHandler creates the backup handler rooted at dataRoot.
func NewBackupHandler(db *gorm.DB, dataRoot string, logger *zap.Logger) *BackupHandler {
	return &BackupHandler{db: db, dataRoot: dataRoot, logger: logger}
}

const backupTimeLayout = "20060102-150405"

var backupNameRe = regexp.MustCompile(`^inkbloom-(\d{8}-\d{6})\.db$`)

type backupEntry struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	SizeBytes int64     `json:"size_bytes"`
	// AssetsName is the companion assets archive (v2 §7.3), empty when the
	// backup predates asset archiving or no assets existed at snapshot time.
	AssetsName string `json:"assets_name,omitempty"`
	AssetsSize int64  `json:"assets_size,omitempty"`
}

// CreateBackup handles POST /api/v1/system/backup.
// It snapshots the live SQLite database via VACUUM INTO (a consistent
// online snapshot that does not block writers) into <dataRoot>/backups and
// then prunes old snapshots per the retention policy (latest one per day
// for the last 7 days + latest one per month for the last 3 months).
func (h *BackupHandler) CreateBackup(c *gin.Context) {
	backupDir := filepath.Join(h.dataRoot, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		h.logger.Error("create backups dir", zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	name := fmt.Sprintf("inkbloom-%s.db", time.Now().Format(backupTimeLayout))
	target := filepath.Join(backupDir, name)

	// VACUUM INTO is the SQLite Online-Backup-equivalent one-shot snapshot.
	if err := h.db.WithContext(c.Request.Context()).Exec("VACUUM INTO ?", target).Error; err != nil {
		h.logger.Error("vacuum into failed", zap.String("target", target), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	info, err := os.Stat(target)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	// Assets archive (v2 §7.3): snapshot the asset tree alongside the DB so
	// a restore brings back portraits/AIGC images too. Empty tree → no zip.
	assetsName, assetsSize, aErr := h.archiveAssets(backupDir, name)
	if aErr != nil {
		// Assets failure must not fail the DB snapshot; log and continue.
		h.logger.Warn("assets archive failed", zap.Error(aErr))
		assetsName, assetsSize = "", 0
	}

	retained := h.prune(backupDir)
	h.logger.Info("backup snapshot created",
		zap.String("file", name), zap.Int64("bytes", info.Size()),
		zap.String("assets", assetsName), zap.Int("retained", retained))

	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "ok", Data: gin.H{
		"name":        name,
		"size_bytes":  info.Size(),
		"assets_name": assetsName,
		"assets_size": assetsSize,
		"retained":    retained,
	}})
}

// ListBackups handles GET /api/v1/system/backups (newest first), letting
// the desktop shell decide whether the startup snapshot is due.
func (h *BackupHandler) ListBackups(c *gin.Context) {
	backupDir := filepath.Join(h.dataRoot, "backups")
	entries, err := h.listEntries(backupDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: entries})
}

func (h *BackupHandler) listEntries(backupDir string) ([]backupEntry, error) {
	dirEntries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []backupEntry{}, nil
		}
		return nil, err
	}
	var out []backupEntry
	for _, e := range dirEntries {
		if e.IsDir() {
			continue
		}
		m := backupNameRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		ts, err := time.ParseInLocation(backupTimeLayout, m[1], time.Local)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		entry := backupEntry{Name: e.Name(), CreatedAt: ts, SizeBytes: info.Size()}
		// Companion assets archive (v2 §7.3): attach when present.
		assetsName := strings.TrimSuffix(e.Name(), ".db") + ".assets.zip"
		if aInfo, aErr := os.Stat(filepath.Join(backupDir, assetsName)); aErr == nil {
			entry.AssetsName = assetsName
			entry.AssetsSize = aInfo.Size()
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// archiveAssets writes a zip of <dataRoot>/assets next to the DB snapshot.
// Returns (zipName, zipSize, error); a missing/empty assets dir yields
// ("", 0, nil) — nothing to archive is not an error.
func (h *BackupHandler) archiveAssets(backupDir, dbName string) (string, int64, error) {
	assetsRoot := filepath.Join(h.dataRoot, "assets")
	info, err := os.Stat(assetsRoot)
	if err != nil || !info.IsDir() {
		return "", 0, nil
	}

	zipName := strings.TrimSuffix(dbName, ".db") + ".assets.zip"
	zipPath := filepath.Join(backupDir, zipName)
	out, err := os.Create(zipPath)
	if err != nil {
		return "", 0, err
	}
	defer out.Close()

	zw := zip.NewWriter(out)
	count := 0
	walkErr := filepath.Walk(assetsRoot, func(path string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return err
		}
		rel, err := filepath.Rel(assetsRoot, path)
		if err != nil {
			return err
		}
		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := io.Copy(w, f); err != nil {
			return err
		}
		count++
		return nil
	})
	if walkErr != nil {
		zw.Close()
		return "", 0, walkErr
	}
	if err := zw.Close(); err != nil {
		return "", 0, err
	}
	if count == 0 {
		os.Remove(zipPath)
		return "", 0, nil
	}
	st, err := os.Stat(zipPath)
	if err != nil {
		return "", 0, err
	}
	return zipName, st.Size(), nil
}

// prune keeps the newest snapshot per day for the last 7 days plus the
// newest snapshot per month for the last 3 months; everything else is
// deleted. Returns the number of retained files.
func (h *BackupHandler) prune(backupDir string) int {
	entries, err := h.listEntries(backupDir)
	if err != nil || len(entries) == 0 {
		return len(entries)
	}

	now := time.Now()
	dailyCutoff := now.AddDate(0, 0, -7)
	monthlyCutoff := now.AddDate(0, -3, 0)

	keep := make(map[string]bool)
	seenDay := make(map[string]bool)
	seenMonth := make(map[string]bool)
	// entries are sorted newest first: the first sighting of a day/month is
	// the newest snapshot for that period.
	for _, e := range entries {
		day := e.CreatedAt.Format("2006-01-02")
		month := e.CreatedAt.Format("2006-01")
		if !e.CreatedAt.Before(dailyCutoff) && !seenDay[day] {
			seenDay[day] = true
			keep[e.Name] = true
		}
		if !e.CreatedAt.Before(monthlyCutoff) && !seenMonth[month] {
			seenMonth[month] = true
			keep[e.Name] = true
		}
	}

	retained := 0
	for _, e := range entries {
		if keep[e.Name] {
			retained++
			continue
		}
		if err := os.Remove(filepath.Join(backupDir, e.Name)); err != nil && !strings.Contains(err.Error(), "no such file") {
			h.logger.Warn("prune backup failed", zap.String("file", e.Name), zap.Error(err))
			retained++
			continue
		}
		// Companion assets archive shares the snapshot lifecycle (v2 §7.3).
		assetsName := strings.TrimSuffix(e.Name, ".db") + ".assets.zip"
		if err := os.Remove(filepath.Join(backupDir, assetsName)); err != nil && !os.IsNotExist(err) {
			h.logger.Warn("prune assets archive failed", zap.String("file", assetsName), zap.Error(err))
		}
	}
	return retained
}

// Restore handles POST /api/v1/system/restore?name=<backup-name>.
// It snapshots the live DB (safety), unpacks the companion assets archive,
// and stages the chosen DB snapshot as <dataRoot>/inkbloom.db.restore-pending.
// The desktop shell then restarts the embedded server; on boot the server
// swaps the pending file into place before opening SQLite (v2 §7.3).
//
// The DB swap is deferred because SQLite holds the live file open on
// Windows — an in-place rename fails with access-denied while the process
// is running.
func (h *BackupHandler) Restore(c *gin.Context) {
	name := c.Query("name")
	if !backupNameRe.MatchString(name) {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid backup name"})
		return
	}
	backupDir := filepath.Join(h.dataRoot, "backups")
	src := filepath.Join(backupDir, name)
	if _, err := os.Stat(src); err != nil {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "backup not found"})
		return
	}

	// 1. Safety snapshot of the current live DB before overwriting.
	preName := fmt.Sprintf("pre-restore-%s.db", time.Now().Format(backupTimeLayout))
	if err := h.db.WithContext(c.Request.Context()).Exec("VACUUM INTO ?", filepath.Join(backupDir, preName)).Error; err != nil {
		h.logger.Warn("pre-restore snapshot failed (continuing)", zap.Error(err))
	}

	// 2. Stage the chosen snapshot for the next boot (deferred swap).
	pending := filepath.Join(h.dataRoot, "inkbloom.db.restore-pending")
	if err := copyFile(src, pending); err != nil {
		h.logger.Error("stage restore failed", zap.String("src", src), zap.Error(err))
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "restore failed: " + err.Error()})
		return
	}

	// 3. Unpack the companion assets archive when present.
	assetsName := strings.TrimSuffix(name, ".db") + ".assets.zip"
	assetsPath := filepath.Join(backupDir, assetsName)
	assetsRestored := 0
	if _, err := os.Stat(assetsPath); err == nil {
		if n, err := unpackZip(assetsPath, filepath.Join(h.dataRoot, "assets")); err != nil {
			h.logger.Warn("assets unpack failed", zap.String("file", assetsName), zap.Error(err))
		} else {
			assetsRestored = n
		}
	}

	h.logger.Info("restore staged (pending reboot)",
		zap.String("backup", name), zap.Int("assets_restored", assetsRestored))
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: gin.H{
		"restored":        name,
		"pre_restore":     preName,
		"assets_restored": assetsRestored,
		"note":            "应用即将重启以完成恢复",
	}})
}

// copyFile copies src to dst atomically-ish (write to temp then rename).
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".restore-tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// unpackZip extracts a zip archive into dir, returning the file count.
// Entries are confined to dir (zip-slip guard).
func unpackZip(zipPath, dir string) (int, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	count := 0
	for _, f := range r.File {
		// Zip-slip guard: the cleaned join must stay inside dir.
		target := filepath.Join(dir, filepath.Clean(f.Name))
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return count, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return count, err
		}
		rc, err := f.Open()
		if err != nil {
			return count, err
		}
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return count, err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
