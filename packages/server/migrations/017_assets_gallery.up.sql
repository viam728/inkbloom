-- Task #57: image gallery support on the assets table.
-- Adds content-hash dedupe columns plus scope/source classification used by
-- the unified image store (/api/v1/images).
--
-- Idempotent (004/010 pattern): GORM AutoMigrate may already have added the
-- columns in SQLite local mode, so ADD COLUMN uses IF NOT EXISTS and every
-- index is guarded by IF NOT EXISTS.
--
-- The (user_id, content_hash) UNIQUE index tolerates multiple NULL
-- content_hash values in both PostgreSQL and SQLite, so legacy AI rows
-- (created before hashing existed) never collide.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS display_name VARCHAR(200);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'novel';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'ai';

CREATE INDEX IF NOT EXISTS idx_assets_content_hash ON assets(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_user_hash ON assets(user_id, content_hash);
