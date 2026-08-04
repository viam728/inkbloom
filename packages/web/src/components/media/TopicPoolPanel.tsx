import React, { useEffect, useState } from 'react';
import { Lightbulb, Plus, Trash2 } from 'lucide-react';
import { useMediaStore } from '@/stores/media-store';
import type { TopicItem } from '@/types/media';

const STATUS_LABEL: Record<TopicItem['status'], string> = {
  idea: '灵感',
  used: '已采用',
  dropped: '已放弃',
};

const STATUS_STYLE: Record<TopicItem['status'], string> = {
  idea: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  used: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  dropped: 'bg-white/5 text-neutral-500 border-white/8',
};

/** 选题池：自媒体创作者管理选题灵感的地方 */
const TopicPoolPanel: React.FC = () => {
  const { topics, loadTopics, addTopic, setTopicStatus, removeTopic } = useMediaStore();
  const [input, setInput] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  const handleAdd = () => {
    if (!input.trim()) return;
    addTopic(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 + 快速添加 */}
      <div className="px-3 py-2 border-b border-white/6">
        <div className="flex items-center gap-1.5 mb-2">
          <Lightbulb size={13} className="text-amber-400" />
          <span className="text-xs font-medium text-neutral-300">选题池</span>
          <span className="ml-auto text-[10px] text-neutral-600">{topics.length} 条</span>
        </div>
        <div className="flex gap-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="记录一个选题灵感…"
            className="flex-1 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-brand-500/50 transition-colors"
          />
          <button
            onClick={handleAdd}
            disabled={!input.trim()}
            className="shrink-0 px-2 py-1.5 rounded-lg bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 disabled:opacity-40 transition-colors"
            title="添加选题"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* 选题列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {topics.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center px-4">
            <Lightbulb size={22} className="text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-500 leading-relaxed">
              随手记录选题灵感，
              <br />
              之后可一键生成标题和内容
            </p>
          </div>
        )}
        {topics.map((topic) => (
          <div
            key={topic.id}
            className="group mx-2 my-0.5 px-3 py-2 rounded-lg border border-transparent hover:bg-white/4 transition-colors"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-neutral-200 leading-relaxed">{topic.title}</p>
                {topic.note && (
                  <p className="text-[10px] text-neutral-500 mt-0.5 line-clamp-2">{topic.note}</p>
                )}
              </div>
              <span
                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[topic.status]}`}
              >
                {STATUS_LABEL[topic.status]}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              {topic.status !== 'used' && (
                <button
                  onClick={() => setTopicStatus(topic.id, 'used')}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600/15 text-emerald-300 hover:bg-emerald-600/25 transition-colors"
                >
                  标记已采用
                </button>
              )}
              {topic.status === 'idea' && (
                <button
                  onClick={() => setTopicStatus(topic.id, 'dropped')}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/6 text-neutral-400 hover:bg-white/12 transition-colors"
                >
                  放弃
                </button>
              )}
              <div className="flex-1" />
              {deleteConfirm === topic.id ? (
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      removeTopic(topic.id);
                      setDeleteConfirm(null);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white"
                  >
                    确认
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(null)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-neutral-300 hover:bg-white/15"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setDeleteConfirm(topic.id)}
                  className="p-0.5 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="删除选题"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TopicPoolPanel;
