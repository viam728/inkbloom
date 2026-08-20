-- Migration 021: content-safety violation audit (tech plan v2 §9.1)
-- Append-only audit trail for the back-office review queue.

CREATE TABLE IF NOT EXISTS content_violations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL DEFAULT 0,
    kind VARCHAR(20) NOT NULL,              -- text | image
    content TEXT,                           -- prompt text or image ref (truncated)
    labels VARCHAR(500),                    -- comma-joined violation labels
    endpoint VARCHAR(100),                  -- API endpoint that triggered the check
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_violations_user ON content_violations(user_id, created_at DESC);
