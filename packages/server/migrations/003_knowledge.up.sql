-- 003_knowledge.up.sql
-- Knowledge graph: nodes (entities) and edges (relations)

CREATE TABLE knowledge_nodes (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),  -- character/location/organization/skill/item
    properties JSONB DEFAULT '{}',
    source_chapter_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_knowledge_nodes_novel ON knowledge_nodes(novel_id, type);
CREATE UNIQUE INDEX idx_knowledge_nodes_unique ON knowledge_nodes(novel_id, name, type);

CREATE TABLE knowledge_edges (
    id BIGSERIAL PRIMARY KEY,
    novel_id BIGINT NOT NULL REFERENCES novels(id),
    source_id BIGINT NOT NULL REFERENCES knowledge_nodes(id),
    target_id BIGINT NOT NULL REFERENCES knowledge_nodes(id),
    relation_type VARCHAR(100),
    description TEXT,
    source_chapter_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_knowledge_edges_unique ON knowledge_edges(novel_id, source_id, target_id, relation_type);
