import { ipcMain, dialog } from 'electron';
import * as fs from 'fs/promises';

export function registerFileHandlers(): void {
  ipcMain.handle('file:read', async (_event, filePath: string): Promise<string> => {
    return await fs.readFile(filePath, 'utf-8');
  });

  ipcMain.handle('file:write', async (_event, filePath: string, data: string): Promise<void> => {
    await fs.writeFile(filePath, data, 'utf-8');
  });

  ipcMain.handle('file:select-dir', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}
