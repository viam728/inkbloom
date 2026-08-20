-- 007_users.up.sql
-- Account system (M1): users table per product-commercialization-plan §2.4 / Appendix A.
-- SMS verification codes are NOT stored in a table: they live in Redis
-- (`smscode:{phone}`, TTL 300s) and refresh token jtis in `refresh:{uid}:{jti}`.
-- Unique constraints sit on nullable columns (PG allows multiple NULLs).
--
-- Idempotent (task #36): the users table is normally created by GORM
-- AutoMigrate (GORM stays the owner of the table shape). This migration
-- therefore only creates the table when absent and, more importantly,
-- realigns the id sequence past any explicitly-seeded ids (demo account
-- id=1 is inserted with a fixed id, which leaves users_id_seq stalled at 1
-- and breaks the first real registration with "duplicate key users_pkey").

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NULL,
    email VARCHAR(255) UNIQUE NULL,
    password_hash TEXT NULL,
    wechat_openid VARCHAR(64) UNIQUE NULL,
    wechat_unionid VARCHAR(64) NULL,
    nickname VARCHAR(64) NOT NULL,
    avatar_url VARCHAR(500) NULL,
    status SMALLINT NOT NULL DEFAULT 0,          -- 0=normal 1=disabled 2=dereg cool-down 3=deregistered
    role SMALLINT NOT NULL DEFAULT 0,            -- 0=user 1=operator
    registered_channel VARCHAR(20) NOT NULL DEFAULT 'sms',
    last_login_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Realign the identity sequence past the maximum existing id. setval(seq,
-- max, true) makes the next nextval() return max+1, so explicitly-seeded
-- ids (demo account) can never collide with fresh registrations.
SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true);

-- Demo account (id=1) is seeded at startup via AuthService.EnsureDemoUser:
-- phone='13800000000', nickname='本地数据用户', password='inkbloom123'
-- (argon2id hashes carry a random salt, so the seed must run in Go code).
-- EnsureDemoUser re-runs the same setval after seeding.
