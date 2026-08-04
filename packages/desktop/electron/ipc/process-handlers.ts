import { ipcMain } from 'electron';
import { ChildProcess } from 'child_process';

interface ServiceStatus {
  go: boolean;
  python: boolean;
}

interface ProcessManager {
  goProcess: ChildProcess | null;
  pythonProcess: ChildProcess | null;
  startGoService: () => void;
  startPythonService: () => void;
}

export function registerProcessHandlers(processManager: ProcessManager): void {
  ipcMain.handle('process:status', async (): Promise<ServiceStatus> => {
    return {
      go: processManager.goProcess !== null && !processManager.goProcess.killed,
      python: processManager.pythonProcess !== null && !processManager.pythonProcess.killed,
    };
  });

  ipcMain.handle('process:restart', async (_event, name: string): Promise<void> => {
    switch (name) {
      case 'go':
        if (processManager.goProcess && !processManager.goProcess.killed) {
          processManager.goProcess.kill('SIGTERM');
        }
        processManager.startGoService();
        break;
      case 'python':
        if (processManager.pythonProcess && !processManager.pythonProcess.killed) {
          processManager.pythonProcess.kill('SIGTERM');
        }
        processManager.startPythonService();
        break;
      default:
        throw new Error(`Unknown service: ${name}`);
    }
  });
}
