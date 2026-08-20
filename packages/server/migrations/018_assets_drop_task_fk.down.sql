-- Task #57 rollback: restore the task_id FK only when no orphan rows exist
-- (uploaded gallery rows carry empty task_id and would violate it).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM assets a
        WHERE a.task_id <> '' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id)
    ) AND NOT EXISTS (SELECT 1 FROM assets WHERE task_id = '') THEN
        ALTER TABLE assets ADD CONSTRAINT assets_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id);
    END IF;
END
$$;
