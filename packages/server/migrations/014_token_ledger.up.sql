-- 014_token_ledger.up.sql
-- M4 AI token billing (product-commercialization-plan §5.1 / Appendix A).
-- Append-only ledger: the single source of truth for billing statements
-- and reconciliation. direction: 1 = credit, -1 = deduction. balance_after
-- snapshots the combined (paid + gift) usable balance after the entry.
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have
-- already created the table from model.TokenLedger.

CREATE TABLE IF NOT EXISTS token_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    direction SMALLINT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    balance_after BIGINT NOT NULL,
    reason VARCHAR(32) NOT NULL,
    ref_type VARCHAR(32),
    ref_id VARCHAR(64),
    model VARCHAR(64),
    prompt_tokens INT,
    completion_tokens INT,
    endpoint VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_user_time ON token_ledger(user_id, created_at DESC);
