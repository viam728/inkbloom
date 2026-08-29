-- Rollback for migration 022 (chapter version history).
-- Only drops the PostgreSQL-specific indexes added by the up migration; the
-- chapter_versions table itself is dropped by GORM AutoMigrate ownership.

DROP INDEX IF EXISTS idx_cver_chapter_time;
DROP INDEX IF EXISTS idx_cver_user_time;
