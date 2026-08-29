-- Rollback for migration 023 (foreshadow tracking).
-- Only drops the PostgreSQL-specific objects; the foreshadows and
-- character_states tables are owned by GORM AutoMigrate.

DROP INDEX IF EXISTS idx_fs_novel_status;

ALTER TABLE character_states
    DROP CONSTRAINT IF EXISTS uq_cs_novel_char_chapter;
