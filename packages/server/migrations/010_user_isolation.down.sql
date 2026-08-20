-- 010_user_isolation.down.sql
-- Reverts M1 per-user isolation. NOTE: ownership beyond the demo account is
-- destroyed — media_memory rows of other users are dropped, and all rows
-- simply lose their user_id column.

-- media_memory: restore the id=1 singleton shape.
ALTER TABLE media_memory DROP CONSTRAINT media_memory_pkey;
DELETE FROM media_memory WHERE user_id <> 1;
ALTER TABLE media_memory DROP COLUMN user_id;
ALTER TABLE media_memory ADD COLUMN id SMALLINT PRIMARY KEY DEFAULT 1;

ALTER TABLE tasks DROP COLUMN user_id;
DROP INDEX IF EXISTS idx_tasks_user;

DROP INDEX IF EXISTS idx_knowledge_edges_user;
ALTER TABLE knowledge_edges DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_knowledge_nodes_user;
ALTER TABLE knowledge_nodes DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_novel_memory_user;
ALTER TABLE novel_memory DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_novel_outline_user;
ALTER TABLE novel_outline DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_assets_user;
ALTER TABLE assets DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_media_topics_user;
ALTER TABLE media_topics DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_media_contents_user;
ALTER TABLE media_contents DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_characters_user;
ALTER TABLE characters DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_settings_user;
ALTER TABLE settings DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_chapters_user;
ALTER TABLE chapters DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_volumes_user;
ALTER TABLE volumes DROP COLUMN user_id;

DROP INDEX IF EXISTS idx_novels_user;
ALTER TABLE novels DROP COLUMN user_id;
