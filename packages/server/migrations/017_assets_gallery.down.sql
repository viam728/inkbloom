-- Task #57 rollback: drop gallery columns and dedupe indexes.

DROP INDEX IF EXISTS idx_assets_user_hash;
DROP INDEX IF EXISTS idx_assets_content_hash;

ALTER TABLE assets DROP COLUMN IF EXISTS content_hash;
ALTER TABLE assets DROP COLUMN IF EXISTS display_name;
ALTER TABLE assets DROP COLUMN IF EXISTS scope;
ALTER TABLE assets DROP COLUMN IF EXISTS source;
