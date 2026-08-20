import { ipcMain } from 'electron';
import { EmbeddedServer } from '../server-manager';

export interface ProcessManager {
  server: EmbeddedServer | null;
  /** Reload the main window from the embedded server after a restart. */
  reloadWindow: () => Promise<void>;
}

/**
 * IPC for the embedded Go server (task #38). The web UI does not depend on
 * these channels; they exist for diagnostics and future settings UI.
 */
export function registerProcessHandlers(manager: ProcessManager): void {
  ipcMain.handle('process:status', async (): Promise<{ server: boolean }> => {
    return { server: manager.server?.isRunning ?? false };
  });

  ipcMain.handle('process:restart', async (_event, name: string): Promise<void> => {
    if (name !== 'server') {
      throw new Error(`Unknown service: ${name}`);
    }
    if (!manager.server) {
      throw new Error('embedded server not initialized');
    }
    await manager.server.restart();
    await manager.reloadWindow();
  });
}
