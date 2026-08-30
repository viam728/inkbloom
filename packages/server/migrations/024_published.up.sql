-- Migration 024: publishing & reading (business plan v3 E4, plan A16)
--
-- Table shape is owned by GORM AutoMigrate, which also creates
--   idx_pc_work  on published_chapters (user_id, work_id, position)
--   idx_pw_user  on published_works   (user_id)
--   idx_rp_user_work / idx_rf_user_work (unique)
--   idx_published_chapters_chapter_id, idx_published_chapters_scheduled_at
--
-- Those all lead with user_id, which is right for author-scoped queries but
-- useless for the two access patterns that actually dominate reading:
--
--   1. "give me this work's chapters in order" — the reader is anonymous, so
--      there is no user_id to filter by, and the composite index cannot be
--      used from its second column.
--   2. "which chapters became due for publication" — the scheduled-release
--      sweep scans a nullable timestamp; a full index would be dominated by
--      the (overwhelmingly common) NULL rows.
--   3. discovery lists only public works ordered newest-first, again with no
--      user predicate.
--
-- Hence the three partial/leading indexes below.
--
-- Idempotent per migration contract C2.

-- Reader-facing chapter ordering within a work.
CREATE INDEX IF NOT EXISTS idx_pc_work_pos
    ON published_chapters (work_id, position);

-- Scheduled-release sweep: partial index skips chapters published immediately,
-- which is the common case and would otherwise bloat the index.
CREATE INDEX IF NOT EXISTS idx_pc_scheduled
    ON published_chapters (scheduled_at)
    WHERE scheduled_at IS NOT NULL;

-- Discovery feed: public works, newest first.
CREATE INDEX IF NOT EXISTS idx_pw_discovery
    ON published_works (visibility, created_at DESC)
    WHERE visibility = 'public';
