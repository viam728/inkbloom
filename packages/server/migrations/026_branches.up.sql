-- 026_branches.up.sql: 世界分支图节点树（全书分支管理）

CREATE TABLE IF NOT EXISTS novel_branches (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    novel_id    BIGINT NOT NULL,
    parent_id   BIGINT,
    title       VARCHAR(255) NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    source      VARCHAR(16) NOT NULL DEFAULT 'user', -- 'ai' | 'user'
    chapter_id  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_novel ON novel_branches(novel_id);
CREATE INDEX IF NOT EXISTS idx_branches_user ON novel_branches(user_id);
CREATE INDEX IF NOT EXISTS idx_branches_parent ON novel_branches(parent_id);
