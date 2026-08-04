-- 002_tasks.down.sql: Drop tasks and outbox tables

DROP INDEX IF EXISTS idx_outbox_status_created;
DROP TABLE IF EXISTS outbox;

DROP INDEX IF EXISTS idx_tasks_chapter_id;
DROP INDEX IF EXISTS idx_tasks_novel_id;
DROP INDEX IF EXISTS idx_tasks_priority_created;
DROP INDEX IF EXISTS idx_tasks_type;
DROP INDEX IF EXISTS idx_tasks_status;
DROP TABLE IF EXISTS tasks;
