package database

import (
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/model"
	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

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
	if err := db.AutoMigrate(
		&model.Novel{},
		&model.Volume{},
		&model.Chapter{},
		&model.Setting{},
		&model.Character{},
		&model.Task{},
		&model.Outbox{},
	); err != nil {
		return nil, fmt.Errorf("failed to auto-migrate: %w", err)
	}

	log.Info("database connection established")
	return db, nil
}
