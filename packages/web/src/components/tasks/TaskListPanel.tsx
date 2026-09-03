import React, { useEffect } from 'react';
import { ListTodo, Loader2, RefreshCw, Ban, Palette, CircleCheck, CircleX, Clock3, LoaderCircle } from 'lucide-react';
import { useTaskStore, type TaskItem } from '@/stores/task-store';
import { useNovelStore } from '@/stores/novel-store';

/** 任务类型 → 展示名与图标（随任务 handler 注册扩展） */
const TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  image_gen: { label: '图片生成', icon: <Palette size={12} /> },
};

const defaultTypeMeta = (type: string) => ({ label: type || '未知任务', icon: <ListTodo size={12} /> });

const STATUS_META: Record<
  TaskItem['status'],
  { label: string; cls: string; icon: React.ReactNode }
> = {
  pending: {
    label: '排队中',
    cls: 'bg-white/6 text-neutral-400 border-white/10',
    icon: <Clock3 size={9} />,
  },
  running: {
    label: '进行中',
    cls: 'bg-brand-500/12 text-brand-300 border-brand-500/25',
    icon: <LoaderCircle size={9} className="animate-spin" />,
  },
  success: {
    label: '已完成',
    cls: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
    icon: <CircleCheck size={9} />,
  },
  failed: {
    label: '失败',
    cls: 'bg-red-500/12 text-red-300 border-red-500/25',
    icon: <CircleX size={9} />,
  },
  dead_letter: {
    label: '失败（重试耗尽）',
    cls: 'bg-red-500/12 text-red-300 border-red-500/25',
    icon: <CircleX size={9} />,
  },
  cancelled: {
    label: '已中止',
    cls: 'bg-white/6 text-neutral-500 border-white/10',
    icon: <Ban size={9} />,
  },
};

/** 任务行 */
const TaskRow: React.FC<{ task: TaskItem }> = ({ task }) => {
  const cancel = useTaskStore((s) => s.cancel);
  const meta = TYPE_META[task.type] ?? defaultTypeMeta(task.type);
  const status = STATUS_META[task.status] ?? STATUS_META.pending;
  const active = task.status === 'pending' || task.status === 'running';
  return (
    <div className="rounded-lg border border-white/6 bg-white/3 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-neutral-500">{meta.icon}</span>
        <span className="flex-1 min-w-0 text-xs text-neutral-200 truncate">{meta.label}</span>
        <span
          className={`shrink-0 flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full border ${status.cls}`}
        >
          {status.icon}
          {status.label}
        </span>
        {active && (
          <button
            onClick={() => {
              if (window.confirm('确定中止该任务？进行中的任务会丢弃结果。')) {
                void cancel(task.id);
              }
            }}
            title="中止任务"
            className="shrink-0 p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Ban size={11} />
          </button>
        )}
      </div>
      {active && (
        <div className="mt-1.5 h-1 rounded-full bg-white/6 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-fuchsia-500 transition-all duration-500"
            style={{ width: `${Math.max(4, task.progress)}%` }}
          />
        </div>
      )}
      {!active && task.error_msg && (
        <p className="mt-1 text-[10px] text-neutral-600 truncate" title={task.error_msg}>
          {task.error_msg}
        </p>
      )}
      <p className="mt-1 text-[9px] text-neutral-700">
        {new Date(task.created_at).toLocaleString()}
      </p>
    </div>
  );
};

/** 右侧板「任务」栏目：后台任务统一管理（当前为 AI 图片生成任务），支持中止 */
const TaskListPanel: React.FC = () => {
  const tasks = useTaskStore((s) => s.tasks);
  const loading = useTaskStore((s) => s.loading);
  const load = useTaskStore((s) => s.load);
  const startWatch = useTaskStore((s) => s.startWatch);
  const currentNovel = useNovelStore((s) => s.currentNovel);

  useEffect(() => {
    startWatch();
    void load();
  }, [startWatch, load]);

  // 切换作品：本地过滤展示（任务面板展示全部任务并标注归属）
  const visible = currentNovel
    ? tasks.filter((t) => t.novel_id == null || t.novel_id === currentNovel.id)
    : tasks;
  const activeCount = visible.filter(
    (t) => t.status === 'pending' || t.status === 'running',
  ).length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <ListTodo size={14} className="text-brand-300" />
        <span className="text-xs font-semibold text-neutral-200">任务</span>
        <span className="text-[10px] text-neutral-600">{visible.length}</span>
        {activeCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/15 text-brand-300 border border-brand-500/25">
            {activeCount} 进行中
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          title="刷新任务列表"
          className="p-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-white/8 transition-colors"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-4 py-10">
            <ListTodo size={24} className="text-neutral-700 mb-2.5" />
            <p className="text-xs text-neutral-500 leading-relaxed">
              暂无后台任务
              <br />
              <span className="text-neutral-600">
                AI 图片生成等任务会在这里统一管理，可随时中止
              </span>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {visible.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskListPanel;
