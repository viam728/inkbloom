-- Migration 022: chapter version history (business plan v3 E1, plan A01)
--
-- Table shape is owned by GORM AutoMigrate (database.automigrateModels), which
-- also creates the composite index idx_cver_chapter(user_id, chapter_id,
-- content_hash, kind, created_at). That composite index cannot serve the two
-- hot queries below, because created_at sits behind three equality columns:
--
--   1. version list for a chapter  -> WHERE chapter_id = ? ORDER BY created_at DESC
--   2. retention sweep per user    -> WHERE user_id = ? AND created_at < cutoff
--
-- These two indexes cover them. Idempotent per migration contract C2.

CREATE INDEX IF NOT EXISTS idx_cver_chapter_time
    ON chapter_versions (chapter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cver_user_time
    ON chapter_versions (user_id, created_at DESC);
