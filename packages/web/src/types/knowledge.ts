// Knowledge graph types

export interface KnowledgeNode {
  id: number;
  name: string;
  type: string;
  properties: Record<string, string>;
  source_chapter_id?: number;
}

export interface KnowledgeEdge {
  id: number;
  source_id: number;
  target_id: number;
  relation_type: string;
  description: string;
  source_chapter_id?: number;
}

export interface GraphData {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface ConsistencyIssue {
  description: string;
  severity: string;
  entity_name: string;
}
