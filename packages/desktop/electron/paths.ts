/**
 * Path / URL resolution for the embedded Go server (task #38, M2-b).
 *
 * Dev layout (pnpm workspace):        Packaged layout (electron-builder):
 *   packages/desktop/dist-electron      resources/server/server.exe
 *   packages/server/bin/server.exe      resources/web-dist/
 *   packages/web/dist/
 */
import { app } from 'electron';
import * as path from 'path';

/** Local-mode server port (contract of task #37: forced 127.0.0.1:18080). */
export const SERVER_PORT = Number(process.env.INKBLOOM_SERVER_PORT ?? 18080);

/** Base URL of the embedded server, which also hosts the web UI. */
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

/**
 * Data root passed to the server as INKBLOOM_SERVER_DATA_ROOT.
 * Default: %APPDATA%/InkBloom (per product plan 1.2). Overridable via
 * INKBLOOM_DESKTOP_DATA_ROOT for smoke tests / portable installs.
 */
export function getDataRoot(): string {
  const override = process.env.INKBLOOM_DESKTOP_DATA_ROOT;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(app.getPath('appData'), 'InkBloom');
}

/** Log directory under the data root (plan 1.2: logs/). */
export function getLogDir(dataRoot: string): string {
  return path.join(dataRoot, 'logs');
}

/** Compiled Go server binary shipped via extraResources when packaged. */
export function getServerBinaryPath(): string {
  const bin = process.platform === 'win32' ? 'server.exe' : 'server';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', bin);
  }
  // dev: dist-electron/ -> packages/desktop -> packages/server/bin
  return path.join(__dirname, '..', '..', 'server', 'bin', bin);
}

/**
 * Web UI build output. In dev it is packages/web/dist (produced by
 * `pnpm --filter @inkbloom/web build`); packaged builds copy it into
 * resources/web-dist via electron-builder extraResources.
 */
export function getWebDistPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web-dist');
  }
  return path.join(__dirname, '..', '..', 'web', 'dist');
}
