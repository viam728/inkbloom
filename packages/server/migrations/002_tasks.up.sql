-- 002_tasks.up.sql: Create tasks and outbox tables

CREATE TABLE IF NOT EXISTS tasks (
    id              VARCHAR(36) PRIMARY KEY,
    type            VARCHAR(50) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    priority        SMALLINT NOT NULL DEFAULT 1,
    payload         JSONB,
    result          JSONB,
    progress        SMALLINT NOT NULL DEFAULT 0,
    error_msg       TEXT,
    retry_count     SMALLINT NOT NULL DEFAULT 0,
    max_retries     SMALLINT NOT NULL DEFAULT 3,
    idempotency_key VARCHAR(64) UNIQUE,
    novel_id        BIGINT,
    chapter_id      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_novel_id ON tasks(novel_id) WHERE novel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_chapter_id ON tasks(chapter_id) WHERE chapter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox (
    id           BIGSERIAL PRIMARY KEY,
    event_type   VARCHAR(100) NOT NULL,
    payload      JSONB NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- Index for polling pending outbox events
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at ASC);
