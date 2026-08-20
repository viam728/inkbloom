-- 016_feedbacks.up.sql
-- M6 user feedback (product-commercialization-plan §7 / task #51).
-- Category: bug / feature / other; status: open -> resolved (back-office).
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have
-- already created the table from model.Feedback.

CREATE TABLE IF NOT EXISTS feedbacks (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    category VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    contact VARCHAR(128),
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_status_created
    ON feedbacks(status, created_at DESC);
