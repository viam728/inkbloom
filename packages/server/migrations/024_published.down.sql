-- Rollback for migration 024 (publishing & reading).
-- Only drops the PostgreSQL-specific indexes; the four tables are owned by
-- GORM AutoMigrate.

DROP INDEX IF EXISTS idx_pc_work_pos;
DROP INDEX IF EXISTS idx_pc_scheduled;
DROP INDEX IF EXISTS idx_pw_discovery;
