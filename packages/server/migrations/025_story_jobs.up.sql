-- Migration 025: Agent 全本创作流水线 story_jobs（plan P1）
--
-- The story_jobs table shape is owned by GORM AutoMigrate. The two access
-- patterns that matter are:
--
--   1. "list my creation jobs, newest first"  — user-scoped, ordered by
--      updated_at. The AutoMigrate user_id index leads with user_id, which
--      serves this well.
--   2. "resume/advance a specific job"        — by id; the primary key covers
--      this.
--
-- We add a user-centric composite index so an active-job sweep (e.g. resume
-- paused jobs) can filter user + status without a second scan.
--
-- Idempotent per migration contract C2.

CREATE INDEX IF NOT EXISTS idx_story_jobs_user_status
    ON story_jobs (user_id, status);

CREATE INDEX IF NOT EXISTS idx_story_jobs_novel
    ON story_jobs (novel_id);
