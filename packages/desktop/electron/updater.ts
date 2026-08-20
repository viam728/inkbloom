/**
 * Auto-update (tech plan v2 §7.1).
 *
 * electron-builder.yml declares a generic-provider publish config whose URL
 * is injected at build time (UPDATE_FEED_URL). This module implements the
 * full user-facing flow:
 *   check → update-available dialog (version + release notes) → user
 *   confirms → download with progress → quit-and-install on confirmation.
 *
 * The beta channel is opt-in via the desktop config key `update_channel`
 * (IPC config:set); anything other than "beta" stays on stable.
 *
 * Failures are logged and never surface as crashes: a broken feed must not
 * block the offline-capable desktop app.
 */
import { app, dialog, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export interface UpdaterOptions {
  /** Reads the desktop config value (update_channel) via IPC layer. */
  getConfig: (key: string) => Promise<string | undefined>;
}

/** initAutoUpdater wires the update lifecycle. Safe to call in dev (no-op). */
export function initAutoUpdater(opts: UpdaterOptions): void {
  // Dev runs are not packaged installers; electron-updater cannot apply
  // updates there, so skip entirely.
  if (!app.isPackaged) {
    console.log('[updater] dev mode, auto-update disabled');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Channel selection: beta opt-in via desktop config (default stable).
  void opts
    .getConfig('update_channel')
    .then((channel) => {
      if (channel === 'beta') {
        autoUpdater.channel = 'beta';
        console.log('[updater] beta channel enabled');
      }
    })
    .catch((err: Error) => console.warn('[updater] channel read failed:', err.message));

  autoUpdater.on('error', (err: Error) => {
    console.warn('[updater] update check failed:', err.message);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
    void promptAndDownload(info.version, typeof info.releaseNotes === 'string' ? info.releaseNotes : '');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version);
    void promptInstall(info.version);
  });

  autoUpdater.on('download-progress', (p) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setProgressBar(p.percent / 100);
    win?.webContents.send('updater:progress', { percent: p.percent });
  });

  void autoUpdater.checkForUpdates().catch((err: Error) => {
    console.warn('[updater] checkForUpdates error:', err.message);
  });
}

/** promptAndDownload asks the user before pulling the update package. */
async function promptAndDownload(version: string, releaseNotes: string): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  const detail = releaseNotes ? `\n\n更新内容：\n${releaseNotes}` : '';
  const { response } = await dialog.showMessageBox(win ?? ({} as BrowserWindow), {
    type: 'info',
    title: '发现新版本',
    message: `InkBloom v${version} 已发布`,
    detail: `是否下载并安装？${detail}`,
    buttons: ['立即下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    return;
  }
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.warn('[updater] download failed:', err instanceof Error ? err.message : err);
    BrowserWindow.getAllWindows()[0]?.setProgressBar(-1);
  }
}

/** promptInstall asks once more before quitting to install. */
async function promptInstall(version: string): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  win?.setProgressBar(-1);
  const { response } = await dialog.showMessageBox(win ?? ({} as BrowserWindow), {
    type: 'info',
    title: '更新已就绪',
    message: `InkBloom v${version} 下载完成`,
    detail: '重启应用以完成安装。未保存的创作内容已自动落盘，可安全重启。',
    buttons: ['重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
}
