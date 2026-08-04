-- 005_frontend_features.down.sql
-- Drop in reverse dependency order.

DROP INDEX IF EXISTS uniq_chapters_novel_position;

DROP TABLE IF EXISTS media_topics;
DROP TABLE IF EXISTS media_contents;
DROP TABLE IF EXISTS novel_memory;
DROP TABLE IF EXISTS novel_outline;

-- Note: the chapter position normalization in the up migration is destructive
-- and cannot be reverted (original duplicated positions are not recoverable).
