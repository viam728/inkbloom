-- 013_token_accounts.up.sql
-- M4 AI token billing (product-commercialization-plan §5.1 / Appendix A).
-- One row per user; balance is denominated in deduction units
-- (input x1 + output x2). gift_balance is deducted first and becomes
-- unusable once gift_expires_at passes (the value stays on the row).
-- version is the optimistic-lock column guarding concurrent deductions.
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have
-- already created the table from model.TokenAccount (without the CHECK
-- constraints, which this file adds for PostgreSQL).

CREATE TABLE IF NOT EXISTS token_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    gift_balance BIGINT NOT NULL DEFAULT 0 CHECK (gift_balance >= 0),
    gift_expires_at TIMESTAMPTZ,
    total_recharged BIGINT NOT NULL DEFAULT 0,
    total_consumed BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
