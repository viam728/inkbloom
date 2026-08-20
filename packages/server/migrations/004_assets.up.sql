-- 004_assets.up.sql: Asset table for AIGC-generated images.
-- Idempotent (task #36): table may already exist via GORM AutoMigrate.

CREATE TABLE IF NOT EXISTS assets (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT REFERENCES novels(id),
    chapter_id BIGINT REFERENCES chapters(id),
    task_id VARCHAR(36) REFERENCES tasks(id),
    file_path VARCHAR(500) NOT NULL,
    thumbnail_path VARCHAR(500),
    prompt TEXT,
    provider VARCHAR(50),
    width INTEGER,
    height INTEGER,
    file_size INTEGER,
    confirmed BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assets_novel ON assets(novel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_chapter ON assets(chapter_id);
CREATE INDEX IF NOT EXISTS idx_assets_task ON assets(task_id);
