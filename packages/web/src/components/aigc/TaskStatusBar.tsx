import React from 'react';
import { useAIGCStore } from '@/stores/aigc-store';

const TaskStatusBar: React.FC = () => {
  const tasks = useAIGCStore((s) => s.tasks);

  const activeTasks = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'running',
  );

  if (activeTasks.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-neutral-900 border-t border-neutral-700 text-xs">
      <span className="text-neutral-400 shrink-0">任务</span>
      {activeTasks.map((task) => (
        <div key={task.id} className="flex items-center gap-2 min-w-0">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              task.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-amber-400'
            }`}
          />
          <span className="text-neutral-300 truncate max-w-[200px]">{task.prompt}</span>
          {task.status === 'running' && (
            <div className="w-16 h-1.5 bg-neutral-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                style={{ width: `${task.progress}%` }}
              />
            </div>
          )}
          <span className="text-neutral-500 shrink-0">
            {task.status === 'running' ? `${task.progress}%` : '等待中'}
          </span>
        </div>
      ))}
    </div>
  );
};

export default TaskStatusBar;
