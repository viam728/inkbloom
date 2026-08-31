-- Rollback for migration 025 (story_jobs indexes).
-- Only drops the two indexes; the table is owned by GORM AutoMigrate.

DROP INDEX IF EXISTS idx_story_jobs_user_status;
DROP INDEX IF EXISTS idx_story_jobs_novel;
