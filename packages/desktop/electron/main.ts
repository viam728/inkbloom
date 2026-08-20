/**
 * InkBloom desktop shell main process (task #38, M2-b).
 *
 * Architecture (product plan 1.1): Electron main process + embedded Go
 * server (local mode, SQLite) + web UI served BY the Go server on
 * http://127.0.0.1:18080. ai-service is NOT embedded; AI stays in the
 * cloud. The renderer therefore loads the server URL directly and all
 * front-end API calls are same-origin /api/v1 requests.
 */
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddedServer } from './server-manager';
import { BackupScheduler } from './backup';
import { getDataRoot, getLogDir, SERVER_URL } from './paths';
import { initAutoUpdater } from './updater';
import { registerProcessHandlers } from './ipc/process-handlers';
import { registerFileHandlers } from './ipc/file-handlers';
import { registerConfigHandlers, readDesktopConfig } from './ipc/config-handlers';

const SPLASH_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>InkBloom</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0b0f14;color:#8fa3b8;font-family:system-ui,sans-serif;flex-direction:column;gap:12px}
  h1{font-size:22px;color:#e6edf3;font-weight:600;margin:0}
  p{font-size:13px;margin:0}
</style></head>
<body><h1>InkBloom</h1><p>正在启动本地数据服务…</p></body></html>`)}`;

class InkBloomDesktop {
  private mainWindow: BrowserWindow | null = null;
  /** server is read by the restore flow (handleRestoreFromBackup). */
  server: EmbeddedServer | null = null;
  private backups: BackupScheduler | null = null;
  private readonly dataRoot = getDataRoot();
  private shuttingDown = false;

  /** Full boot sequence: server -> readiness -> window -> backup schedule. */
  async boot(): Promise<void> {
    Menu.setApplicationMenu(buildApplicationMenu());
    fs.mkdirSync(getLogDir(this.dataRoot), { recursive: true });
    this.redirectMainLogs();

    this.server = new EmbeddedServer({
      dataRoot: this.dataRoot,
      onUnexpectedExit: (_code, restarted) => {
        if (!restarted) {
          void this.handleServerGone();
        }
      },
    });

    this.registerIpcHandlers();
    this.createWindow();

    try {
      await this.server.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[desktop] server boot failed:', message);
      dialog.showErrorBox('InkBloom 启动失败', `本地数据服务未能就绪：\n${message}`);
      app.exit(1);
      return;
    }

    // Web UI is served by the embedded Go server (SPA fallback included).
    await this.mainWindow?.loadURL(SERVER_URL + '/');

    // Plan 1.3: startup snapshot (≥24h gate) + daily 03:00 schedule.
    this.backups = new BackupScheduler(SERVER_URL);
    void this.backups.maybeStartupBackup();
    this.backups.scheduleDaily();

    initAutoUpdater({
      getConfig: async (key) => {
        const cfg = await readDesktopConfig(this.dataRoot);
        const v = cfg[key];
        return typeof v === 'string' ? v : undefined;
      },
    });
    console.log('[desktop] boot complete:', SERVER_URL);
  }

  createWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 700,
      title: 'InkBloom',
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    void this.mainWindow.loadURL(SPLASH_HTML);

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  /** Crash beyond the auto-restart budget: let the user decide. */
  private async handleServerGone(): Promise<void> {
    if (this.shuttingDown || !this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }
    const logFile = path.join(getLogDir(this.dataRoot), 'server.log');
    const { response } = await dialog.showMessageBox(this.mainWindow, {
      type: 'error',
      title: '本地数据服务已停止',
      message: '内嵌数据服务异常退出，且自动重启次数已用尽。',
      detail: `日志位置：${logFile}`,
      buttons: ['重新启动服务', '打开日志目录', '退出 InkBloom'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0 && this.server) {
      try {
        await this.server.restart();
        await this.mainWindow?.loadURL(SERVER_URL + '/');
      } catch (err) {
        dialog.showErrorBox('重启失败', err instanceof Error ? err.message : String(err));
      }
    } else if (response === 1) {
      void shell.openPath(getLogDir(this.dataRoot));
    } else {
      app.quit();
    }
  }

  private registerIpcHandlers(): void {
    registerProcessHandlers({
      server: this.server,
      reloadWindow: async () => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          await this.mainWindow.loadURL(SERVER_URL + '/');
        }
      },
    });
    registerFileHandlers();
    registerConfigHandlers(this.dataRoot);
  }

  /** Mirror main-process console output into <dataRoot>/logs/desktop.log. */
  private redirectMainLogs(): void {
    const logFile = path.join(getLogDir(this.dataRoot), 'desktop.log');
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const write =
      (prefix: string, original: (...args: unknown[]) => void) =>
      (...args: unknown[]): void => {
        const line = `${new Date().toISOString()} ${args.map(String).join(' ')}\n`;
        stream.write(prefix + line);
        original(...args);
      };
    console.log = write('', console.log.bind(console));
    console.warn = write('WARN ', console.warn.bind(console));
    console.error = write('ERROR ', console.error.bind(console));
  }

  /** Graceful shutdown: backup scheduler down, server killed. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.backups?.stop();
    if (this.server) {
      console.log('[desktop] stopping embedded server…');
      await this.server.stop();
    }
    console.log('[desktop] shutdown complete');
  }
}

// ──────────────────────────────────────────────────────
// App lifecycle + single instance lock
// ──────────────────────────────────────────────────────
// Application menu (task #38 item 5: the cloud-sync placeholder lives here;
// the web UI has no settings page yet and must stay untouched).
function buildApplicationMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '设置',
      submenu: [
        {
          // 云同步入口（v2 §7.2）：打开渲染进程的「数据与同步」弹窗。
          label: '数据与云同步',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            win?.webContents.send('menu:open-data-modal');
          },
        },
        {
          // 备份恢复（v2 §7.3）：选择备份 → 恢复 → 重启内嵌服务。
          label: '从备份恢复…',
          click: () => {
            void handleRestoreFromBackup();
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => {
            void shell.openPath(getDataRoot());
          },
        },
        {
          label: '关于 InkBloom',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 InkBloom',
              message: `InkBloom 桌面版 v${app.getVersion()}`,
              detail: '本地内嵌数据服务 + 云端 AI。',
            });
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

const desktop = new InkBloomDesktop();

/** 备份恢复流程（v2 §7.3）：列出备份 → 用户选择 → 确认 → 恢复 → 重启。 */
async function handleRestoreFromBackup(): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || !desktop.server) {
    return;
  }
  try {
    // 1. 拉取备份列表
    const resp = await fetch(`${SERVER_URL}/api/v1/system/backups`);
    const body = (await resp.json()) as { code: number; data?: { name: string; created_at: string; size_bytes: number }[] };
    const backups = body.data ?? [];
    if (backups.length === 0) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: '从备份恢复',
        message: '暂无可用备份',
        detail: '应用会在启动时与每日 03:00 自动创建备份。',
      });
      return;
    }

    // 2. 用户选择备份（取最近 10 份供选择）
    const candidates = backups.slice(0, 10);
    const labels = candidates.map((b) => `${b.name}（${new Date(b.created_at).toLocaleString()}）`);
    const pick = await dialog.showMessageBox(win, {
      type: 'question',
      title: '从备份恢复',
      message: '选择要恢复的备份（恢复前会自动为当前数据创建安全快照）',
      buttons: [...labels, '取消'],
      defaultId: 0,
      cancelId: labels.length,
    });
    if (pick.response >= labels.length) {
      return;
    }
    const chosen = candidates[pick.response];

    // 3. 二次确认
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '确认恢复',
      message: `将用备份 ${chosen.name} 覆盖当前数据`,
      detail: '恢复后应用将自动重启。当前数据会先保存为 pre-restore 快照，可再次恢复。',
      buttons: ['确认恢复', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirm.response !== 0) {
      return;
    }

    // 4. 调用恢复端点 + 重启内嵌服务
    const restoreResp = await fetch(`${SERVER_URL}/api/v1/system/restore?name=${encodeURIComponent(chosen.name)}`, { method: 'POST' });
    const restoreBody = (await restoreResp.json()) as { code: number; message?: string };
    if (restoreBody.code !== 200) {
      throw new Error(restoreBody.message || `恢复失败（${restoreResp.status}）`);
    }
    await desktop.server.restart();
    await win.loadURL(SERVER_URL + '/');
    await dialog.showMessageBox(win, {
      type: 'info',
      title: '恢复完成',
      message: '已从备份恢复并重启',
    });
  } catch (err) {
    await dialog.showErrorBox('恢复失败', err instanceof Error ? err.message : String(err));
  }
}

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the embedded server port; do not double-spawn.
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    void desktop.boot();

    app.on('activate', () => {
      // macOS: re-create a window when dock icon is clicked.
      if (BrowserWindow.getAllWindows().length === 0) {
        desktop.createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    // Make shutdown awaited exactly once.
    event.preventDefault();
    void desktop.shutdown().finally(() => app.exit(0));
  });
}
