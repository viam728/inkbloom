-- 001_init.up.sql
-- InkBloom initial schema

-- novels 小说表
CREATE TABLE novels (
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
CREATE INDEX idx_novels_status ON novels(status) WHERE deleted_at IS NULL;

-- volumes 卷表
CREATE TABLE volumes (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    title VARCHAR(255) NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_volumes_novel ON volumes(novel_id, position);

-- chapters 章节表
CREATE TABLE chapters (
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
CREATE INDEX idx_chapters_novel ON chapters(novel_id, position);

-- settings 设定表
CREATE TABLE settings (
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
CREATE TABLE characters (
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
