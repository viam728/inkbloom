import React, { useEffect, useRef, useCallback } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import type { GraphData, KnowledgeNode } from '@/types/knowledge';

// Node type colors
const NODE_COLORS: Record<string, string> = {
  character: '#3B82F6',   // blue
  location: '#10B981',    // green
  organization: '#F59E0B', // yellow
  skill: '#EF4444',       // red
  item: '#8B5CF6',        // purple
};

const NODE_TYPE_LABELS: Record<string, string> = {
  character: '角色',
  location: '地点',
  organization: '组织',
  skill: '技能',
  item: '物品',
};

interface KnowledgeGraphProps {
  data: GraphData | null;
  onNodeSelect?: (node: KnowledgeNode | null) => void;
}

const KnowledgeGraph: React.FC<KnowledgeGraphProps> = ({ data, onNodeSelect }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const initGraph = useCallback(() => {
    if (!containerRef.current) return;

    // Destroy previous instance
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '11px',
            color: '#e5e7eb',
            'text-margin-y': 6,
            width: 30,
            height: 30,
            'border-width': 2,
            'border-color': '#374151',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'node[type="character"]',
          style: { 'background-color': NODE_COLORS.character } as cytoscape.Css.Node,
        },
        {
          selector: 'node[type="location"]',
          style: { 'background-color': NODE_COLORS.location } as cytoscape.Css.Node,
        },
        {
          selector: 'node[type="organization"]',
          style: { 'background-color': NODE_COLORS.organization } as cytoscape.Css.Node,
        },
        {
          selector: 'node[type="skill"]',
          style: { 'background-color': NODE_COLORS.skill } as cytoscape.Css.Node,
        },
        {
          selector: 'node[type="item"]',
          style: { 'background-color': NODE_COLORS.item } as cytoscape.Css.Node,
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#4B5563',
            'target-arrow-color': '#4B5563',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '9px',
            color: '#9CA3AF',
            'text-rotation': 'autorotate',
            'text-margin-y': -8,
          } as cytoscape.Css.Edge,
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#60A5FA',
          } as cytoscape.Css.Node,
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#60A5FA',
            'target-arrow-color': '#60A5FA',
            width: 2.5,
          } as cytoscape.Css.Edge,
        },
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 500,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 100,
        edgeElasticity: () => 100,
        gravity: 0.25,
        numIter: 1000,
      } as cytoscape.CoseLayoutOptions,
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    cyRef.current = cy;

    // Node click handler
    cy.on('tap', 'node', (evt: EventObject) => {
      const nodeData = evt.target.data();
      if (onNodeSelect) {
        onNodeSelect({
          id: nodeData.id,
          name: nodeData.label,
          type: nodeData.type,
          properties: nodeData.properties || {},
          source_chapter_id: nodeData.source_chapter_id,
        });
      }
    });

    // Background click — deselect
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        if (onNodeSelect) onNodeSelect(null);
      }
    });

    return cy;
  }, [onNodeSelect]);

  useEffect(() => {
    const cy = initGraph();
    if (!cy) return;

    if (!data || !data.nodes || data.nodes.length === 0) {
      return;
    }

    // Add nodes
    const elements: cytoscape.ElementDefinition[] = data.nodes.map((node) => ({
      data: {
        id: String(node.id),
        label: node.name,
        type: node.type || 'item',
        properties: node.properties,
        source_chapter_id: node.source_chapter_id,
      },
    }));

    // Add edges
    const nodeIds = new Set(data.nodes.map((n) => String(n.id)));
    data.edges?.forEach((edge) => {
      const sourceId = String(edge.source_id);
      const targetId = String(edge.target_id);
      if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
        elements.push({
          data: {
            id: String(edge.id),
            source: sourceId,
            target: targetId,
            label: edge.relation_type || '',
          },
        });
      }
    });

    cy.add(elements);
    cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 500,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 100,
      edgeElasticity: () => 100,
      gravity: 0.25,
      numIter: 1000,
    } as cytoscape.CoseLayoutOptions).run();

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, initGraph]);

  return (
    <div className="relative w-full h-full" style={{ backgroundColor: '#111827' }}>
      <div ref={containerRef} className="w-full h-full" />

      {/* Legend */}
      <div
        className="absolute top-2 left-2 p-2 rounded text-xs"
        style={{ backgroundColor: 'rgba(17,24,39,0.85)', border: '1px solid #374151' }}
      >
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5 mb-0.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span style={{ color: '#d1d5db' }}>{NODE_TYPE_LABELS[type] || type}</span>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {(!data || !data.nodes || data.nodes.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p style={{ color: '#6B7280' }}>暂无知识图谱数据</p>
        </div>
      )}
    </div>
  );
};

export default KnowledgeGraph;
