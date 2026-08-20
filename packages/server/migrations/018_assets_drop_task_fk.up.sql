-- Task #57: uploaded gallery images have no generation task, so the
-- assets.task_id -> tasks(id) foreign key must go (task_id stays
-- informational for AI-generated rows). SQLite local mode is unaffected
-- (AutoMigrate never created the FK there).

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_task_id_fkey;
