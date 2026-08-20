-- 012_payment_orders.up.sql
-- M3 payment orders (product-commercialization-plan Appendix A).
-- out_trade_no is the idempotency key for channel callbacks. `period`
-- (month|year) is added beyond the doc DDL so the order list contract
-- (GET /api/v1/payment/orders) can report the paid subscription period.
--
-- Idempotent (task #36 runner convention): GORM AutoMigrate may have already
-- created the table from model.PaymentOrder.

CREATE TABLE IF NOT EXISTS payment_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    kind VARCHAR(20) NOT NULL,
    period VARCHAR(10),
    ref_id BIGINT,
    channel VARCHAR(20) NOT NULL,
    amount_cents INT NOT NULL,
    out_trade_no VARCHAR(64) NOT NULL UNIQUE,
    channel_trade_no VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    paid_at TIMESTAMPTZ,
    fulfilled_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id);
