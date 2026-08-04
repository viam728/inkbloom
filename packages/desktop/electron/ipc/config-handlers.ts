import { ipcMain, app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse, stringify } from 'yaml';

function getConfigPath(): string {
  const home = app.getPath('home');
  return path.join(home, '.inkbloom', 'config.yaml');
}

async function ensureConfigDir(): Promise<void> {
  const configDir = path.dirname(getConfigPath());
  await fs.mkdir(configDir, { recursive: true });
}

async function readConfigFile(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(getConfigPath(), 'utf-8');
    return (parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

async function writeConfigFile(config: Record<string, unknown>): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getConfigPath(), stringify(config), 'utf-8');
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:get', async (): Promise<Record<string, unknown>> => {
    return await readConfigFile();
  });

  ipcMain.handle('config:set', async (_event, key: string, value: string): Promise<void> => {
    const config = await readConfigFile();
    config[key] = value;
    await writeConfigFile(config);
  });

  ipcMain.handle('app:version', async (): Promise<string> => {
    return app.getVersion();
  });
}
