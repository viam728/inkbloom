-- 010_user_isolation.up.sql
-- M1 per-user data isolation (product-commercialization-plan Appendix A/B).
-- Every business table gains user_id BIGINT NOT NULL DEFAULT 1, which both
-- declares ownership going forward and backfills all existing rows to the
-- demo account (users.id = 1, seeded via AuthService.EnsureDemoUser).
-- Tables carrying deleted_at get a PARTIAL index on user_id (hot path only
-- touches live rows); the rest get plain indexes.
--
-- Idempotent (task #36): GORM AutoMigrate may have already added user_id
-- columns (it adds missing columns but can never drop columns or swap
-- primary keys), so ADD COLUMN uses IF NOT EXISTS and the media_memory
-- primary-key swap is guarded by conditional DO blocks.

-- novels
ALTER TABLE novels ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_novels_user ON novels(user_id) WHERE deleted_at IS NULL;

-- volumes
ALTER TABLE volumes ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_volumes_user ON volumes(user_id) WHERE deleted_at IS NULL;

-- chapters
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_chapters_user ON chapters(user_id) WHERE deleted_at IS NULL;

-- settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id) WHERE deleted_at IS NULL;

-- characters
ALTER TABLE characters ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id) WHERE deleted_at IS NULL;

-- media_contents
ALTER TABLE media_contents ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_media_contents_user ON media_contents(user_id) WHERE deleted_at IS NULL;

-- media_topics
ALTER TABLE media_topics ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_media_topics_user ON media_topics(user_id);

-- assets (AIGC images)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);

-- novel_outline / novel_memory (1:1 with novels; user_id kept for parity
-- and defense-in-depth, access is gated through novel ownership)
ALTER TABLE novel_outline ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_novel_outline_user ON novel_outline(user_id);

ALTER TABLE novel_memory ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_novel_memory_user ON novel_memory(user_id);

-- knowledge graph
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_user ON knowledge_nodes(user_id);

ALTER TABLE knowledge_edges ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_user ON knowledge_edges(user_id);

-- tasks (AIGC async tasks)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);

-- media_memory: global singleton (PK id SMALLINT DEFAULT 1) → one row per
-- user. The single legacy row (id=1) inherits user_id=1 via the DEFAULT.
-- AutoMigrate already adds user_id (new model shape), so the ADD COLUMN is
-- guarded; the DROP id / re-key must still run exactly once and is made
-- safe against both the old singleton shape and the new per-user shape.
ALTER TABLE media_memory ADD COLUMN IF NOT EXISTS user_id BIGINT NOT NULL DEFAULT 1;

DO $$
BEGIN
    -- Drop the legacy id-based primary key if it still exists.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'media_memory_pkey' AND conrelid = 'media_memory'::regclass
    ) THEN
        ALTER TABLE media_memory DROP CONSTRAINT media_memory_pkey;
    END IF;
END
$$;

DO $$
BEGIN
    -- Remove the legacy id column once nothing depends on it.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'media_memory' AND column_name = 'id'
    ) THEN
        ALTER TABLE media_memory DROP COLUMN id;
    END IF;
END
$$;

DO $$
BEGIN
    -- Establish user_id as the primary key when not yet present.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'media_memory_pkey' AND conrelid = 'media_memory'::regclass
    ) THEN
        ALTER TABLE media_memory ADD PRIMARY KEY (user_id);
    END IF;
END
$$;
