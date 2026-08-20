-- 001_init.up.sql
-- InkBloom initial schema.
-- Idempotent (task #36): tables may already exist via GORM AutoMigrate,
-- which has historically been the only migration mechanism in this repo.

-- novels 小说表
CREATE TABLE IF NOT EXISTS novels (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    genre VARCHAR(100),
    description TEXT,
    cover_image VARCHAR(500),
    word_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_novels_status ON novels(status) WHERE deleted_at IS NULL;

-- volumes 卷表
CREATE TABLE IF NOT EXISTS volumes (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    title VARCHAR(255) NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_volumes_novel ON volumes(novel_id, position);

-- chapters 章节表
CREATE TABLE IF NOT EXISTS chapters (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    volume_id BIGINT REFERENCES volumes(id),
    title VARCHAR(255) NOT NULL,
    content TEXT,
    content_json JSONB,
    word_count INTEGER DEFAULT 0,
    position INTEGER NOT NULL,
    summary TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id, position);

-- settings 设定表
CREATE TABLE IF NOT EXISTS settings (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    content TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- characters 角色表
CREATE TABLE IF NOT EXISTS characters (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100),
    brief TEXT,
    appearance TEXT,
    background TEXT,
    personality TEXT,
    goals TEXT,
    abilities TEXT,
    avatar_path VARCHAR(500),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
