import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CloudDownload,
  CloudUpload,
  Database,
  Download,
  FileArchive,
  LoaderCircle,
  Upload,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import { toast } from '@/components/common/Toast';
import { useUIStore } from '@/stores/ui-store';
import { useAuthStore } from '@/stores/auth-store';
import { COUNT_LABELS, IMPORT_MAX_BYTES, useSyncStore } from '@/stores/sync-store';
import { isDesktopShell } from '@/utils/platform';

/** 提取错误信息：axios 业务错误优先取 response.data.message */
function errMsg(e: unknown): string {
  const axiosMsg = (e as { response?: { data?: { message?: string } } })?.response?.data
    ?.message;
  if (axiosMsg) return axiosMsg;
  if (e instanceof Error && e.message) return e.message;
  return '网络异常，请稍后重试';
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 数据管理：全量导出备份 / 导入 .inkbloom 备份包 */
const DataModal: React.FC = () => {
  const open = useUIStore((s) => s.dataOpen);
  const setOpen = useUIStore((s) => s.setDataOpen);
  const exporting = useSyncStore((s) => s.exporting);
  const importing = useSyncStore((s) => s.importing);
  const cloudSyncing = useSyncStore((s) => s.cloudSyncing);
  const lastResult = useSyncStore((s) => s.lastResult);
  const { exportData, importData, uploadToCloud, pullFromCloud } = useSyncStore();
  const isAuthed = useAuthStore((s) => s.status === 'authed' && !!s.access_token);
  const isDesktop = isDesktopShell();

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (exporting) return;
    try {
      await exportData();
      toast.show('导出完成', 'success');
    } catch (e) {
      toast.show(errMsg(e), 'error');
    }
  };

  /** 校验并接收文件（点击选择 / 拖拽共用） */
  const acceptFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.inkbloom')) {
      toast.show('请选择 .inkbloom 备份文件', 'error');
      return;
    }
    if (f.size > IMPORT_MAX_BYTES) {
      toast.show('文件超过 500MB 上限', 'error');
      return;
    }
    setFile(f);
  };

  const handleImportConfirmed = async () => {
    setConfirmOpen(false);
    if (!file || importing) return;
    try {
      await importData(file);
      toast.show('导入完成', 'success');
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      toast.show(errMsg(e), 'error');
    }
  };

  /** 桌面端云同步（v2 §7.2）：未登录云端时先唤起登录 */
  const handleCloudSync = async (direction: 'upload' | 'pull') => {
    if (!isDesktop) return;
    if (!isAuthed) {
      toast.show('请先登录云端账号', 'error');
      useUIStore.getState().setDataOpen(false);
      // 登录面板由顶栏用户入口唤起；此处仅提示
      return;
    }
    try {
      const result = direction === 'upload' ? await uploadToCloud() : await pullFromCloud();
      toast.show(
        direction === 'upload'
          ? `已上传到云端（新增 ${Object.values(result.created).reduce((a, b) => a + b, 0)} 条）`
          : `已从云端拉取（新增 ${Object.values(result.created).reduce((a, b) => a + b, 0)} 条）`,
        'success',
      );
    } catch (e) {
      toast.show(errMsg(e), 'error');
    }
  };

  const createdEntries = lastResult
    ? COUNT_LABELS.filter(({ key }) => lastResult.created?.[key] > 0)
    : [];

  return (
    <>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex items-center gap-2">
            <Database size={15} className="text-brand-300" />
            数据管理
          </span>
        }
        width="560px"
      >
        <div className="p-5 space-y-5">
          {/* ===== 云同步区（仅桌面端，v2 §7.2） ===== */}
          {isDesktop && (
            <section className="glass-panel rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
                  <CloudUpload size={16} className="text-emerald-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-semibold text-neutral-200">云同步</h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                    本地数据与云端双向同步。上传以本地为准合并到云端；拉取以云端为准合并到本地。
                    同名内容按更新时间合并，冲突生成副本。
                  </p>
                </div>
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-2.5">
                <button
                  onClick={() => handleCloudSync('upload')}
                  disabled={cloudSyncing}
                  className="py-2.5 rounded-xl text-xs font-semibold text-white
                    bg-gradient-to-r from-emerald-500 to-teal-500 hover:opacity-90 transition-opacity
                    shadow-md shadow-emerald-500/20 active:scale-[0.985]
                    disabled:opacity-60 disabled:cursor-not-allowed
                    flex items-center justify-center gap-2"
                >
                  {cloudSyncing ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <CloudUpload size={14} />
                  )}
                  上传到云端
                </button>
                <button
                  onClick={() => handleCloudSync('pull')}
                  disabled={cloudSyncing}
                  className="py-2.5 rounded-xl text-xs font-semibold text-white
                    bg-gradient-to-r from-sky-500 to-indigo-500 hover:opacity-90 transition-opacity
                    shadow-md shadow-sky-500/20 active:scale-[0.985]
                    disabled:opacity-60 disabled:cursor-not-allowed
                    flex items-center justify-center gap-2"
                >
                  {cloudSyncing ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <CloudDownload size={14} />
                  )}
                  从云端拉取
                </button>
              </div>
              {!isAuthed && (
                <p className="mt-2.5 text-[10px] text-amber-300/90 flex items-center gap-1">
                  <AlertTriangle size={11} />
                  云同步需登录云端账号（点击右上角用户入口登录）
                </p>
              )}
            </section>
          )}

          {/* ===== 导出区 ===== */}
          <section className="glass-panel rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 shrink-0 rounded-xl bg-brand-500/15 border border-brand-500/25 flex items-center justify-center">
                <Download size={16} className="text-brand-300" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold text-neutral-200">导出数据</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                  将全部小说、媒体内容、知识图谱与素材打包导出为 .inkbloom
                  备份文件，可随时用于迁移或恢复。
                </p>
              </div>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="mt-3.5 w-full py-2.5 rounded-xl text-sm font-semibold tracking-widest text-white
                bg-gradient-to-r from-indigo-500 via-brand-500 to-pink-500 bg-[length:200%_100%]
                hover:bg-right transition-all duration-300 shadow-lg shadow-indigo-500/25
                active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {exporting ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              {exporting ? '正在打包…' : '导出数据'}
            </button>
          </section>

          {/* ===== 导入区 ===== */}
          <section className="glass-panel rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 shrink-0 rounded-xl bg-pink-500/15 border border-pink-500/25 flex items-center justify-center">
                <Upload size={16} className="text-pink-300" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold text-neutral-200">导入数据</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                  从 .inkbloom 备份包恢复数据（≤500MB），不会删除现有内容。
                </p>
              </div>
            </div>

            {/* 拖拽 / 点击选择 */}
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                acceptFile(e.dataTransfer.files?.[0]);
              }}
              className={`mt-3.5 rounded-xl border border-dashed px-4 py-6 text-center cursor-pointer transition-all duration-200 ${
                dragOver
                  ? 'border-brand-400/70 bg-brand-500/10'
                  : 'border-white/12 bg-white/3 hover:border-white/25 hover:bg-white/5'
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".inkbloom"
                className="hidden"
                onChange={(e) => acceptFile(e.target.files?.[0])}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-neutral-200">
                  <FileArchive size={16} className="text-brand-300 shrink-0" />
                  <span className="truncate max-w-64">{file.name}</span>
                  <span className="text-[10px] text-neutral-500 shrink-0">{fmtSize(file.size)}</span>
                </div>
              ) : (
                <>
                  <FileArchive size={20} className="mx-auto text-neutral-600" />
                  <p className="mt-2 text-xs text-neutral-400">点击选择或拖拽 .inkbloom 文件到此处</p>
                  <p className="mt-1 text-[10px] text-neutral-600">仅支持 InkBloom 备份包 · 最大 500MB</p>
                </>
              )}
            </div>

            <button
              onClick={() => setConfirmOpen(true)}
              disabled={!file || importing}
              className="mt-3 w-full py-2.5 rounded-xl text-sm font-semibold tracking-widest text-white
                bg-gradient-to-r from-pink-500 via-brand-500 to-indigo-500 bg-[length:200%_100%]
                hover:bg-right transition-all duration-300 shadow-lg shadow-pink-500/20
                active:scale-[0.985] disabled:opacity-50 disabled:cursor-not-allowed
                flex items-center justify-center gap-2"
            >
              {importing ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <Upload size={15} />
              )}
              {importing ? '正在导入…' : '导入数据'}
            </button>

            {/* ===== 导入结果摘要 ===== */}
            {lastResult && (
              <div className="mt-4 rounded-xl border border-white/8 bg-white/3 p-3.5 animate-fade-in">
                <h5 className="text-[11px] tracking-[0.18em] text-neutral-500 mb-2.5">导入结果</h5>
                {createdEntries.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {createdEntries.map(({ key, label }) => (
                      <span
                        key={key}
                        className="px-2 py-1 rounded-lg text-[10px] bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 tabular-nums"
                      >
                        新增{label} {lastResult.created[key]}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-neutral-600">无新增数据</p>
                )}
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400 tabular-nums">
                  <span>
                    更新 <span className="text-brand-300">{lastResult.updated}</span>
                  </span>
                  <span>
                    冲突副本 <span className="text-amber-300">{lastResult.conflicts}</span>
                  </span>
                  <span>
                    跳过 <span className="text-neutral-500">{lastResult.skipped}</span>
                  </span>
                </div>
                {lastResult.conflicts > 0 && (
                  <p className="mt-2.5 px-3 py-2 rounded-lg text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25 flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    已生成冲突副本，请在作品列表中核对
                  </p>
                )}
                {lastResult.message && (
                  <p className="mt-2 text-[10px] text-neutral-600">{lastResult.message}</p>
                )}
              </div>
            )}
          </section>
        </div>
      </Modal>

      {/* ===== 导入前确认对话框 ===== */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="确认导入" width="400px">
        <div className="p-5">
          <p className="text-sm leading-relaxed text-neutral-300">
            导入不会删除现有数据，同名作品按更新时间合并或生成冲突副本。
          </p>
          <div className="mt-5 flex gap-2.5">
            <button
              onClick={() => setConfirmOpen(false)}
              className="flex-1 py-2 rounded-xl text-xs font-medium text-neutral-300 bg-white/6 border border-white/10 hover:bg-white/10 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleImportConfirmed}
              className="flex-1 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-pink-500 hover:opacity-90 transition-opacity shadow-md shadow-indigo-500/20"
            >
              确认导入
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default DataModal;
