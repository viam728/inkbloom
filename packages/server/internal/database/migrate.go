package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// SQL migration runner (task #36).
//
// Historically the migrations/*.sql files were never executed at startup:
// the schema drifted entirely on GORM AutoMigrate, so real structural
// changes (migration 010's media_memory PK swap) never reached the
// database. This runner executes pending `NNN_name.up.sql` files in
// ascending version order, records applied versions in schema_migrations,
// and fails startup fast on any error (never skip silently).
//
// Idempotency strategy: each *.up.sql file is written to be safe against a
// schema already produced by AutoMigrate (CREATE TABLE IF NOT EXISTS,
// conditional DDL in DO blocks, ADD COLUMN IF NOT EXISTS), so re-running a
// migration never errors even if its structural work is already partially
// present.

var migrationFileRe = regexp.MustCompile(`^(\d+)_.+\.up\.sql$`)

// RunMigrations applies pending SQL migrations from dir (ascending version).
func RunMigrations(ctx context.Context, db *gorm.DB, dir string, log *zap.Logger) error {
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("migrations dir %s: %w", dir, err)
	}

	if err := db.WithContext(ctx).Exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
	).Error; err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	type mig struct {
		version int
		name    string
		path    string
	}
	var files []mig
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := migrationFileRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		v, err := strconv.Atoi(m[1])
		if err != nil {
			return fmt.Errorf("bad migration version in %s: %w", e.Name(), err)
		}
		files = append(files, mig{version: v, name: e.Name(), path: filepath.Join(dir, e.Name())})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].version < files[j].version })

	var applied []int
	if err := db.WithContext(ctx).
		Table("schema_migrations").
		Order("version").
		Pluck("version", &applied).Error; err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	done := make(map[int]bool, len(applied))
	for _, v := range applied {
		done[v] = true
	}

	for _, f := range files {
		if done[f.version] {
			continue
		}
		sqlText, err := os.ReadFile(f.path)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", f.name, err)
		}
		log.Info("applying SQL migration", zap.Int("version", f.version), zap.String("name", f.name))
		start := time.Now()
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec(string(sqlText)).Error; err != nil {
				return err
			}
			return tx.Exec(
				`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, now())`,
				f.version, f.name,
			).Error
		}); err != nil {
			return fmt.Errorf("migration %s failed: %w", f.name, err)
		}
		log.Info("SQL migration applied", zap.Int("version", f.version), zap.Duration("took", time.Since(start)))
	}

	log.Info("database migrations up to date", zap.Int("total_files", len(files)), zap.Int("previously_applied", len(applied)))
	return nil
}

// MigrationsDir resolves the migrations directory from the executable's
// location (repo layouts: run from packages/server, or from repo root).
func MigrationsDir() string {
	if d := os.Getenv("INKBLOOM_MIGRATIONS_DIR"); d != "" {
		return d
	}
	candidates := []string{"migrations", "packages/server/migrations"}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return strings.Join(candidates, " | ") // fallback: RunMigrations reports the error
}
