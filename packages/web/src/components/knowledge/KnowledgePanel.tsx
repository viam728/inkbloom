import React, { useState, useEffect } from 'react';
import { Network, ChevronDown, Loader2 } from 'lucide-react';
import KnowledgeGraph from './KnowledgeGraph';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { useNovelStore } from '@/stores/novel-store';
import { useToast } from '@/components/common/Toast';
import type { KnowledgeNode, ConsistencyIssue } from '@/types/knowledge';

const severityStyle: Record<string, string> = {
  error: 'bg-red-500 text-white',
  warning: 'bg-amber-500 text-white',
  info: 'bg-neutral-500 text-white',
};

const KnowledgePanel: React.FC = () => {
  const { currentNovel, currentChapter } = useNovelStore();
  const { graph, loading, extracting, checking, fetchGraph, extractEntities, checkConsistency } =
    useKnowledgeStore();
  const { showToast } = useToast();

  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
  const [issues, setIssues] = useState<ConsistencyIssue[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  // Fetch graph when novel is selected
  useEffect(() => {
    if (currentNovel) {
      fetchGraph(currentNovel.id);
    }
  }, [currentNovel, fetchGraph]);

  const handleExtract = async () => {
    if (!currentNovel || !currentChapter) return;
    const text = currentChapter.content || '';
    if (!text) {
      showToast('当前章节没有内容，无法提取实体', 'error');
      return;
    }
    try {
      await extractEntities(currentNovel.id, currentChapter.id, text);
    } catch {
      // error handled in store
    }
  };

  const handleCheck = async () => {
    if (!currentNovel || !currentChapter) return;
    const text = currentChapter.content || '';
    if (!text) {
      showToast('当前章节没有内容，无法检测一致性', 'error');
      return;
    }
    const result = await checkConsistency(currentNovel.id, currentChapter.id, text);
    setIssues(result);
    if (result.length === 0) {
      showToast('未检测到一致性问题', 'success');
    }
  };

  if (!currentNovel) return null;

  return (
    <div className="flex flex-col border-t border-white/6">
      {/* Header */}
      <button
        className="flex items-center justify-between px-3.5 py-2 w-full text-left hover:bg-white/4 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          <Network size={12} className="text-brand-400" />
          知识图谱
        </span>
        <ChevronDown
          size={13}
          className={`text-neutral-600 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>

      {!collapsed && (
        <div className="flex flex-col animate-fade-in">
          {/* Action buttons */}
          <div className="flex gap-2 px-3 py-1.5">
            <button
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-brand-600/15 text-brand-300 border border-brand-500/25 hover:bg-brand-600/25 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              disabled={extracting || !currentChapter}
              onClick={handleExtract}
            >
              {extracting && <Loader2 size={11} className="animate-spin" />}
              {extracting ? '提取中…' : '提取实体'}
            </button>
            <button
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-amber-500/12 text-amber-300 border border-amber-500/25 hover:bg-amber-500/20 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              disabled={checking || !currentChapter}
              onClick={handleCheck}
            >
              {checking && <Loader2 size={11} className="animate-spin" />}
              {checking ? '检测中…' : '一致性检测'}
            </button>
          </div>

          {/* Graph area */}
          <div className="h-[260px] mx-2 rounded-lg overflow-hidden bg-surface-0/60 border border-white/5">
            {loading ? (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <Loader2 size={16} className="animate-spin text-brand-400" />
                <p className="text-xs text-neutral-600">加载中…</p>
              </div>
            ) : (
              <KnowledgeGraph data={graph} onNodeSelect={setSelectedNode} />
            )}
          </div>

          {/* Node detail card */}
          {selectedNode && (
            <div className="mx-3 mt-2 p-2.5 rounded-lg bg-white/4 border border-white/6 animate-fade-in">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-neutral-200">{selectedNode.name}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-brand-500/15 text-brand-300 border border-brand-500/25">
                  {selectedNode.type}
                </span>
              </div>
              {selectedNode.properties?.description && (
                <p className="text-xs text-neutral-400 leading-relaxed">
                  {selectedNode.properties.description}
                </p>
              )}
            </div>
          )}

          {/* Consistency issues */}
          {issues.length > 0 && (
            <div className="mx-3 my-2 p-2.5 rounded-lg bg-amber-500/6 border border-amber-500/20 animate-fade-in">
              <p className="text-xs font-semibold mb-1.5 text-amber-300">
                一致性问题 ({issues.length})
              </p>
              {issues.map((issue, i) => (
                <div key={i} className="mb-1 text-xs text-neutral-300 leading-relaxed">
                  <span
                    className={`inline-block px-1 py-px rounded mr-1.5 text-[10px] ${
                      severityStyle[issue.severity] ?? severityStyle.info
                    }`}
                  >
                    {issue.severity}
                  </span>
                  {issue.entity_name && <span className="font-medium">{issue.entity_name}: </span>}
                  {issue.description}
                </div>
              ))}
            </div>
          )}
          {issues.length === 0 && selectedNode === null && <div className="h-2" />}
        </div>
      )}
    </div>
  );
};

export default KnowledgePanel;
