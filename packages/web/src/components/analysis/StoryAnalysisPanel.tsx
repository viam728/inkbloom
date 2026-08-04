import React, { useMemo, useState } from 'react';
import {
  BarChart3,
  Users,
  Activity,
  Stethoscope,
  X,
  Loader2,
  BookOpen,
  Megaphone,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useNovelStore } from '@/stores/novel-store';
import { useOutlineStore, type OutlineAct } from '@/stores/outline-store';
import { useMemoryStore, type MemoryItem } from '@/stores/memory-store';
import { useMediaStore } from '@/stores/media-store';
import { analyzeStory, analyzeMedia, type AnalysisReport } from '@/services/analysis-client';
import { computeRhythm } from '@/services/rhythm-client';

// 模块级稳定空数组：避免 selector 每次返回新引用导致无限渲染循环
const EMPTY_OUTLINES: OutlineAct[] = [];
const EMPTY_MEMORIES: MemoryItem[] = [];

type SubTab = 'structure' | 'characters' | 'rhythm' | 'diagnosis';

/** 角色关系图谱的 SVG 渲染 */
const CharacterGraph: React.FC<{ characters: { name: string; tags: string[] }[] }> = ({
  characters,
}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 90;

  if (characters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Users size={24} className="text-neutral-600 mb-2" />
        <p className="text-xs text-neutral-500">暂无角色数据，请在记忆面板中添加人物卡</p>
      </div>
    );
  }

  const nodes = characters.map((c, i) => {
    const angle = (2 * Math.PI * i) / characters.length - Math.PI / 2;
    return {
      ...c,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  // 计算共享标签产生的连线
  const edges: { from: number; to: number; weight: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].tags.filter((t) => nodes[j].tags.includes(t));
      if (shared.length > 0) {
        edges.push({ from: i, to: j, weight: shared.length });
      }
    }
  }

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="select-none">
        {/* 连线 */}
        {edges.map((e, i) => (
          <line
            key={i}
            x1={nodes[e.from].x}
            y1={nodes[e.from].y}
            x2={nodes[e.to].x}
            y2={nodes[e.to].y}
            stroke="rgba(99,102,241,0.3)"
            strokeWidth={Math.min(e.weight, 3)}
          />
        ))}
        {/* 节点 */}
        {nodes.map((n, i) => (
          <g
            key={i}
            className="cursor-pointer"
            onClick={() => setSelected(selected === n.name ? null : n.name)}
          >
            <circle
              cx={n.x}
              cy={n.y}
              r={selected === n.name ? 14 : 10}
              fill={selected === n.name ? '#818cf8' : '#374151'}
              stroke="#818cf8"
              strokeWidth="1.5"
              className="transition-all"
            />
            <text
              x={n.x}
              y={n.y + radius * 0.22 + 16}
              textAnchor="middle"
              fill="rgba(255,255,255,0.7)"
              fontSize="10"
            >
              {n.name.length > 4 ? n.name.slice(0, 4) + '…' : n.name}
            </text>
          </g>
        ))}
        {/* 中心节点 */}
        <circle cx={cx} cy={cy} r={16} fill="rgba(99,102,241,0.15)" stroke="#818cf8" strokeWidth="1" />
        <text x={cx} y={cy + 4} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="9">
          故事
        </text>
      </svg>
      {selected && (
        <div className="mt-2 p-2 rounded-lg bg-white/5 border border-white/8 text-xs text-neutral-300 animate-fade-in">
          <span className="font-medium text-brand-300">{selected}</span>
          {(characters.find((c) => c.name === selected)?.tags.length ?? 0) > 0 && (
            <span className="ml-2 text-neutral-500">
              标签: {characters.find((c) => c.name === selected)?.tags.join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/** 节奏曲线迷你图 */
const MiniRhythm: React.FC = () => {
  const chapters = useNovelStore((s) => s.chapters);
  const points = useMemo(() => computeRhythm(chapters, null), [chapters]);
  const W = 240;
  const H = 80;
  const PAD = 8;
  const n = points.length;

  if (n === 0) {
    return <p className="text-xs text-neutral-500 py-4 text-center">暂无章节数据</p>;
  }

  const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));
  const y = (score: number) => H - PAD - (score / 100) * (H - PAD * 2);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <defs>
        <linearGradient id="mini-rhythm" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#f472b6" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((v) => (
        <line
          key={v}
          x1={PAD}
          x2={W - PAD}
          y1={y(v)}
          y2={y(v)}
          stroke="rgba(255,255,255,0.05)"
          strokeDasharray="2 3"
        />
      ))}
      <path d={path} fill="none" stroke="url(#mini-rhythm)" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.score)} r={3} fill="#818cf8" />
      ))}
    </svg>
  );
};

/** 评分条 */
const ScoreBar: React.FC<{ label: string; score: number; tip: string }> = ({ label, score, tip }) => {
  const color = score >= 70 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-neutral-300">{label}</span>
        <span className="text-xs text-neutral-500 tabular-nums">{score}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-500`}
          style={{ width: `${score}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-neutral-500 leading-relaxed">{tip}</p>
    </div>
  );
};

const StoryAnalysisPanel: React.FC = () => {
  const role = useUIStore((s) => s.role);
  const toggleAnalysis = useUIStore((s) => s.toggleAnalysis);
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const chapters = useNovelStore((s) => s.chapters);
  const outline = useOutlineStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] ?? EMPTY_OUTLINES : EMPTY_OUTLINES,
  );
  const memory = useMemoryStore((s) =>
    currentNovel ? s.byNovel[currentNovel.id] ?? EMPTY_MEMORIES : EMPTY_MEMORIES,
  );
  const currentContent = useMediaStore((s) => s.currentContent);

  const [subTab, setSubTab] = useState<SubTab>('structure');
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(false);

  // 角色列表
  const characters = useMemo(
    () => memory.filter((m) => m.type === 'character'),
    [memory],
  );

  const handleAnalyze = async () => {
    setLoading(true);
    setReport(null);
    try {
      if (role === 'novelist') {
        const result = await analyzeStory({
          title: currentNovel?.title ?? '',
          chapters,
          outline,
          memory,
        });
        setReport(result);
      } else if (role === 'media') {
        if (currentContent) {
          const result = await analyzeMedia(currentContent);
          setReport(result);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const isNovelist = role === 'novelist';

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/6">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-brand-400" />
          <span className="text-xs font-medium text-neutral-200">整体分析</span>
        </div>
        <button
          onClick={toggleAnalysis}
          className="p-1 rounded text-neutral-500 hover:text-neutral-300 transition-colors"
          title="关闭 (Ctrl+I)"
        >
          <X size={14} />
        </button>
      </div>

      {/* 子标签 */}
      {isNovelist && (
        <div className="flex gap-1 px-2 py-1.5 border-b border-white/6">
          {(
            [
              { id: 'structure', label: '结构', icon: <BookOpen size={11} /> },
              { id: 'characters', label: '角色', icon: <Users size={11} /> },
              { id: 'rhythm', label: '节奏', icon: <Activity size={11} /> },
              { id: 'diagnosis', label: '诊断', icon: <Stethoscope size={11} /> },
            ] as { id: SubTab; label: string; icon: React.ReactNode }[]
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1 px-1.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                subTab === tab.id
                  ? 'bg-brand-600/20 text-brand-300'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {isNovelist ? (
          <>
            {/* 结构视图 */}
            {subTab === 'structure' && (
              <div className="space-y-3 animate-fade-in">
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded-lg bg-white/4 border border-white/6">
                    <p className="text-[10px] text-neutral-500 mb-0.5">总字数</p>
                    <p className="text-sm font-semibold text-neutral-200 tabular-nums">
                      {chapters.reduce((a, c) => a + (c.word_count ?? 0), 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/4 border border-white/6">
                    <p className="text-[10px] text-neutral-500 mb-0.5">章节数</p>
                    <p className="text-sm font-semibold text-neutral-200 tabular-nums">
                      {chapters.length}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/4 border border-white/6">
                    <p className="text-[10px] text-neutral-500 mb-0.5">大纲幕数</p>
                    <p className="text-sm font-semibold text-neutral-200 tabular-nums">
                      {outline.length}
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/4 border border-white/6">
                    <p className="text-[10px] text-neutral-500 mb-0.5">角色数</p>
                    <p className="text-sm font-semibold text-neutral-200 tabular-nums">
                      {characters.length}
                    </p>
                  </div>
                </div>

                {/* 幕结构进度 */}
                {outline.length > 0 && (
                  <div>
                    <p className="text-[11px] text-neutral-400 mb-2 font-medium">大纲结构</p>
                    {outline.map((act) => {
                      const done = act.nodes.filter((n) => n.status === 'done').length;
                      const total = act.nodes.length;
                      const pct = total > 0 ? (done / total) * 100 : 0;
                      return (
                        <div key={act.id} className="mb-2">
                          <div className="flex justify-between text-[11px] mb-1">
                            <span className="text-neutral-400">{act.title}</span>
                            <span className="text-neutral-500 tabular-nums">
                              {done}/{total}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-pink-500 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 角色图谱 */}
            {subTab === 'characters' && (
              <div className="animate-fade-in">
                <CharacterGraph characters={characters} />
              </div>
            )}

            {/* 节奏曲线 */}
            {subTab === 'rhythm' && (
              <div className="animate-fade-in">
                <p className="text-[11px] text-neutral-500 mb-2">章节张力分布</p>
                <MiniRhythm />
              </div>
            )}

            {/* 诊断 */}
            {subTab === 'diagnosis' && (
              <div className="animate-fade-in">
                {report ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-10 h-10 rounded-full border-2 border-brand-500/40 flex items-center justify-center">
                        <span className="text-sm font-bold text-brand-300">{report.score}</span>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-neutral-200">综合评分</p>
                        <p className="text-[10px] text-neutral-500">基于结构、节奏、角色等维度</p>
                      </div>
                    </div>
                    {report.dimensions.map((d) => (
                      <ScoreBar key={d.label} label={d.label} score={d.score} tip={d.tip} />
                    ))}
                    <div className="pt-2 border-t border-white/6">
                      <p className="text-[11px] text-neutral-400 mb-1.5 font-medium">建议</p>
                      {report.suggestions.map((s, i) => (
                        <p key={i} className="text-[11px] text-neutral-500 mb-1 pl-2 relative">
                          <span className="absolute left-0">•</span>
                          {s}
                        </p>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={handleAnalyze}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {loading ? <Loader2 size={13} className="animate-spin" /> : <Stethoscope size={13} />}
                    {loading ? '分析中…' : '运行整体分析'}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          /* ===== 自媒体模式分析 ===== */
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center gap-2 mb-2">
              <Megaphone size={13} className="text-pink-400" />
              <span className="text-xs font-medium text-neutral-300">内容诊断</span>
            </div>
            {report ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-10 h-10 rounded-full border-2 border-pink-500/40 flex items-center justify-center">
                    <span className="text-sm font-bold text-pink-300">{report.score}</span>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-neutral-200">内容评分</p>
                    <p className="text-[10px] text-neutral-500">平台适配度综合评估</p>
                  </div>
                </div>
                {report.dimensions.map((d) => (
                  <ScoreBar key={d.label} label={d.label} score={d.score} tip={d.tip} />
                ))}
                {report.suggestions.length > 0 && (
                  <div className="pt-2 border-t border-white/6">
                    <p className="text-[11px] text-neutral-400 mb-1.5 font-medium">优化建议</p>
                    {report.suggestions.map((s, i) => (
                      <p key={i} className="text-[11px] text-neutral-500 mb-1 pl-2 relative">
                        <span className="absolute left-0">•</span>
                        {s}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ) : currentContent ? (
              <button
                onClick={handleAnalyze}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-pink-600/20 text-pink-300 hover:bg-pink-600/30 text-xs font-medium transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Stethoscope size={13} />}
                {loading ? '分析中…' : '分析当前内容'}
              </button>
            ) : (
              <p className="text-xs text-neutral-500 text-center py-6">
                请先选择一篇内容进行分析
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default StoryAnalysisPanel;
