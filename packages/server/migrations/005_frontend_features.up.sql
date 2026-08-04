-- 005_frontend_features.up.sql
-- Frontend-facing features: novel outline / memory, media workspace tables,
-- and chapter position normalization backed by a partial unique index.

-- 1) Normalize existing chapter positions (dedupe before creating the unique index).
--    Order is derived from (novel_id, created_at, id), rewritten to 0-based positions.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY novel_id ORDER BY created_at, id) - 1 AS new_position
    FROM chapters
    WHERE deleted_at IS NULL
)
UPDATE chapters AS c
SET position = ranked.new_position
FROM ranked
WHERE c.id = ranked.id
  AND c.position IS DISTINCT FROM ranked.new_position;

-- 2) novel_outline: structured outline (acts) per novel
CREATE TABLE novel_outline (
    novel_id BIGINT PRIMARY KEY REFERENCES novels(id),
    acts JSONB NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) novel_memory: curated memory items per novel
CREATE TABLE novel_memory (
    novel_id BIGINT PRIMARY KEY REFERENCES novels(id),
    items JSONB NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4) media_contents: self-media content entries with drag-sortable positions
CREATE TABLE media_contents (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    platform VARCHAR(20) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tags JSONB NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_media_contents_deleted ON media_contents(deleted_at);
CREATE INDEX idx_media_contents_position ON media_contents(position);

-- 5) media_topics: topic idea kanban items
CREATE TABLE media_topics (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'idea',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6) Enforce unique (novel_id, position) among non-soft-deleted chapters.
--    chapters.deleted_at exists since 001_init.up.sql, so a partial unique index applies.
CREATE UNIQUE INDEX uniq_chapters_novel_position ON chapters(novel_id, position) WHERE deleted_at IS NULL;
