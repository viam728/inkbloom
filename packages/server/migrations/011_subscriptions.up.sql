-- 011_subscriptions.up.sql
-- M3 subscription billing (product-commercialization-plan §3 / Appendix A).
-- One row per user; the state machine (trialing → active → grace → dormant)
-- is time-driven and derived at read time from expires_at, so no cron flips
-- statuses. grace_until = expires_at + 30d is informational.
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have already
-- created the table from model.Subscription.

CREATE TABLE IF NOT EXISTS subscriptions (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    plan VARCHAR(20) NOT NULL DEFAULT 'base',
    status VARCHAR(20) NOT NULL DEFAULT 'trialing',
    started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    grace_until TIMESTAMPTZ,
    last_payment_order_id BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subs_expiry ON subscriptions(status, expires_at);
