-- 006_media_memory.up.sql
-- Global shared memory document for the self-media workspace.
-- Idempotent (task #36): table may already exist via GORM AutoMigrate.
-- NOTE: migration 010 later converts this singleton (PK id) into one row
-- per user (PK user_id); keep this CREATE shape only for fresh databases
-- that have not yet applied 010.

CREATE TABLE IF NOT EXISTS media_memory (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    items JSONB NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
