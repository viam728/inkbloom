import { ipcMain, app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Desktop-side settings stored as JSON inside the data root
 * (task #38: everything the shell owns lives under %APPDATA%/InkBloom).
 * The Go server configuration itself is env-driven in local mode.
 */
function getConfigPath(dataRoot: string): string {
  return path.join(dataRoot, 'desktop-config.json');
}

async function readConfigFile(dataRoot: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(getConfigPath(dataRoot), 'utf-8');
    return (JSON.parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/** readDesktopConfig exposes the config file to the main process itself
 * (the updater reads update_channel without going through IPC). */
export async function readDesktopConfig(dataRoot: string): Promise<Record<string, unknown>> {
  return readConfigFile(dataRoot);
}

async function writeConfigFile(dataRoot: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(getConfigPath(dataRoot), JSON.stringify(config, null, 2), 'utf-8');
}

export function registerConfigHandlers(dataRoot: string): void {
  ipcMain.handle('config:get', async (): Promise<Record<string, unknown>> => {
    return await readConfigFile(dataRoot);
  });

  ipcMain.handle('config:set', async (_event, key: string, value: string): Promise<void> => {
    const config = await readConfigFile(dataRoot);
    config[key] = value;
    await writeConfigFile(dataRoot, config);
  });

  ipcMain.handle('app:version', async (): Promise<string> => {
    return app.getVersion();
  });
}
