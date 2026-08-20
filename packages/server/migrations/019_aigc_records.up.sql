-- Task #64: AIGC generation history records.
-- Every image generation (including dedupe hits that reuse an existing
-- asset) writes one aigc_records row, so the global AIGC history is
-- complete even when the underlying bytes are shared.
--
-- Idempotent (004/010/017 pattern): GORM AutoMigrate creates the table in
-- SQLite local mode, so CREATE TABLE / CREATE INDEX are guarded by
-- IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS aigc_records (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    task_id VARCHAR(36) NOT NULL,
    prompt TEXT NOT NULL,
    provider VARCHAR(50) NOT NULL,
    asset_id BIGINT NOT NULL,
    novel_id BIGINT,
    scope VARCHAR(20) NOT NULL DEFAULT 'novel',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aigc_records_user_created
    ON aigc_records(user_id, created_at DESC);
