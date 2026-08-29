-- Migration 023: foreshadow tracking (business plan v3 E2, plan A10)
--
-- Table shape is owned by GORM AutoMigrate, which also creates
--   idx_fs_novel  on foreshadows     (user_id, novel_id, status)
--   idx_cs_novel  on character_states(user_id, novel_id, character_id, chapter_id)
--
-- Both lead with user_id, so they cannot serve these two needs:
--
--   1. "all unresolved threads of this novel" filters by (novel_id, status)
--      across the author's whole book, without a user predicate in the hot
--      path of the reminder job (plan A15).
--   2. character_states needs a real UNIQUE constraint so repeated snapshot
--      writes can upsert instead of racing into duplicate rows. GORM creates
--      a plain (non-unique) index here.
--
-- Note on dual-mode: this migration only runs on PostgreSQL. SQLite cannot
-- add a UNIQUE constraint via ALTER TABLE, so local/embedded mode relies on
-- the service layer's read-then-write upsert instead. Both paths converge on
-- "one row per (novel, character, chapter)".
--
-- Idempotent per migration contract C2.

CREATE INDEX IF NOT EXISTS idx_fs_novel_status
    ON foreshadows (novel_id, status);

-- Dedupe defensively before adding the constraint: an earlier build could
-- have written duplicates while the constraint was absent.
DELETE FROM character_states a
    USING character_states b
WHERE a.ctid < b.ctid
  AND a.novel_id = b.novel_id
  AND a.character_id = b.character_id
  AND a.chapter_id = b.chapter_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_cs_novel_char_chapter'
    ) THEN
        ALTER TABLE character_states
            ADD CONSTRAINT uq_cs_novel_char_chapter
            UNIQUE (novel_id, character_id, chapter_id);
    END IF;
END $$;
