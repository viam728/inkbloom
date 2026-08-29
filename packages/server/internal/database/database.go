package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/model"
	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// automigrateModels is the single source of truth for GORM AutoMigrate in
// both cloud (PostgreSQL) and local (SQLite) modes.
func automigrateModels() []interface{} {
	return []interface{}{
		&model.Novel{},
		&model.Volume{},
		&model.Chapter{},
		// E1 chapter version history (business plan v3, construction plan A01).
		&model.ChapterVersion{},
		&model.Setting{},
		&model.Character{},
		&model.Task{},
		&model.Outbox{},
		&model.MediaMemory{},
		&model.MediaContent{},
		&model.MediaTopic{},
		&model.Asset{},
		&model.AIGCRecord{},
		&model.KnowledgeNode{},
		&model.KnowledgeEdge{},
		&model.NovelOutline{},
		&model.NovelMemory{},
		&model.User{},
		&model.Subscription{},
		&model.PaymentOrder{},
		&model.TokenAccount{},
		&model.TokenLedger{},
		&model.TokenOrder{},
		&model.Feedback{},
		// Product analytics (business plan v3 appendix B, plan A40).
		&model.Event{},
		// E2 foreshadow tracking (business plan v3, plan A10).
		&model.Foreshadow{},
		&model.CharacterState{},
	}
}

// NewPostgresDB initializes a new GORM DB connection to PostgreSQL.
func NewPostgresDB(cfg *config.Config, log *zap.Logger) (*gorm.DB, error) {
	if cfg.Database.URL == "" {
		return nil, fmt.Errorf("database URL is not configured")
	}

	// Configure GORM logger based on server mode
	gormLogger := logger.Default.LogMode(logger.Silent)
	if cfg.Server.Mode == "debug" {
		gormLogger = logger.Default.LogMode(logger.Warn)
	}

	db, err := gorm.Open(postgres.Open(cfg.Database.URL), &gorm.Config{
		Logger: gormLogger,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get underlying sql.DB: %w", err)
	}

	// Configure connection pool
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	// Always run AutoMigrate to ensure schema is up-to-date
	log.Info("running database migrations")
	if err := db.AutoMigrate(automigrateModels()...); err != nil {
		return nil, fmt.Errorf("failed to auto-migrate: %w", err)
	}

	// Apply SQL migrations (task #36): AutoMigrate only adds missing
	// columns/tables; structural changes like media_memory's primary-key
	// swap live in migrations/*.sql and must actually execute. Failures are
	// fatal — the server must not start on a partially migrated schema.
	if err := RunMigrations(context.Background(), db, MigrationsDir(), log); err != nil {
		return nil, fmt.Errorf("failed to run SQL migrations: %w", err)
	}

	log.Info("database connection established")
	return db, nil
}

// NewSQLiteDB opens the embedded SQLite database for local mode (task #37,
// M2-a). The file lives under the data root; the schema is managed purely
// by GORM AutoMigrate — the migrations/*.sql files are PostgreSQL dialect
// and are intentionally skipped here. WAL journal mode keeps the single
// writer (server) from blocking readers (Electron backup copies).
//
// Restore handoff (v2 §7.3): when <dataRoot>/inkbloom.db.restore-pending
// exists (staged by BackupHandler.Restore), it is swapped into place BEFORE
// the DB is opened — SQLite holds the live file open, so the swap must
// happen before gorm.Open.
func NewSQLiteDB(dataRoot string, log *zap.Logger) (*gorm.DB, error) {
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create data root %s: %w", dataRoot, err)
	}

	// Deferred restore: swap the staged snapshot into place before opening.
	// The staged snapshot is a self-contained SQLite file (created by
	// VACUUM INTO / copyFile). Any WAL/SHM files left by the previous live
	// DB must be removed first, otherwise SQLite sees a WAL that does not
	// belong to the restored snapshot and reports "database disk image is
	// malformed" on Windows.
	liveDB := filepath.Join(dataRoot, "inkbloom.db")
	pending := liveDB + ".restore-pending"
	if _, err := os.Stat(pending); err == nil {
		for _, suffix := range []string{"", "-wal", "-shm"} {
			if rmErr := os.Remove(liveDB + suffix); rmErr != nil && !os.IsNotExist(rmErr) {
				log.Warn("failed to remove stale db file before restore", zap.String("file", liveDB+suffix), zap.Error(rmErr))
			}
		}
		if err := os.Rename(pending, liveDB); err != nil {
			return nil, fmt.Errorf("apply staged restore %s: %w", pending, err)
		}
		log.Info("applied staged restore", zap.String("file", liveDB))
	}

	dsn := liveDB +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"

	gormLogger := logger.Default.LogMode(logger.Silent)
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: gormLogger})
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get underlying sql.DB: %w", err)
	}
	// SQLite allows a single writer; keep the pool small.
	sqlDB.SetMaxOpenConns(4)
	sqlDB.SetMaxIdleConns(2)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	log.Info("running sqlite auto-migrate", zap.String("file", dsn))
	if err := db.AutoMigrate(automigrateModels()...); err != nil {
		return nil, fmt.Errorf("failed to auto-migrate sqlite: %w", err)
	}

	log.Info("sqlite database ready")
	return db, nil
}
