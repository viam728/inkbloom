-- 015_token_orders.up.sql
-- M4 AI token billing (product-commercialization-plan §5.2 / Appendix A).
-- Recharge orders for token packs (standard / pro). out_trade_no is the
-- idempotency key; the sandbox channel pays instantly (created -> paid in
-- the same request). Column names follow the frozen GET /token/orders
-- contract (pack / tokens) while keeping the Appendix A order shape.
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have
-- already created the table from model.TokenOrder.

CREATE TABLE IF NOT EXISTS token_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    pack VARCHAR(20) NOT NULL,
    tokens BIGINT NOT NULL,
    amount_cents INT NOT NULL,
    channel VARCHAR(20) NOT NULL,
    out_trade_no VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_orders_user ON token_orders(user_id);
