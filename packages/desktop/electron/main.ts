import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import { registerProcessHandlers } from './ipc/process-handlers';
import { registerFileHandlers } from './ipc/file-handlers';
import { registerConfigHandlers } from './ipc/config-handlers';

const isDev = process.env.NODE_ENV === 'development';

class InkBloomApp {
  private mainWindow: BrowserWindow | null = null;
  private goProcess: ChildProcess | null = null;
  private pythonProcess: ChildProcess | null = null;

  async createWindow(): Promise<void> {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 700,
      title: 'InkBloom - AIGC 图文创作工具',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (isDev) {
      await this.mainWindow.loadURL('http://localhost:3000');
      this.mainWindow.webContents.openDevTools();
    } else {
      await this.mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  /**
   * 启动 Go 后端子进程
   */
  startGoService(): void {
    const goPath = this.getGoServicePath();
    this.goProcess = spawn(goPath, [], {
      env: { ...process.env, INKBLOOM_SERVER_MODE: 'release' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.goProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[Go]', data.toString());
    });
    this.goProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[Go]', data.toString());
    });
    this.goProcess.on('exit', (code: number | null) => {
      console.log('[Go] exited with code', code);
      this.goProcess = null;
    });
    this.goProcess.on('error', (err: Error) => {
      console.error('[Go] failed to start:', err.message);
    });
  }

  /**
   * 启动 Python AI 服务子进程
   */
  startPythonService(): void {
    const pythonPath = this.getPythonServicePath();
    this.pythonProcess = spawn('python', ['-m', 'app.main'], {
      cwd: path.join(__dirname, '../../ai-service'),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.pythonProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[Python]', data.toString());
    });
    this.pythonProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[Python]', data.toString());
    });
    this.pythonProcess.on('exit', (code: number | null) => {
      console.log('[Python] exited with code', code);
      this.pythonProcess = null;
    });
    this.pythonProcess.on('error', (err: Error) => {
      console.error('[Python] failed to start:', err.message);
    });
  }

  /**
   * 健康检查：轮询等待所有后端服务就绪
   */
  async waitForServices(timeout = 30000): Promise<void> {
    const services = [
      { name: 'Go', url: 'http://localhost:8080/health' },
      { name: 'Python', url: 'http://localhost:8100/health' },
    ];

    const deadline = Date.now() + timeout;

    for (const service of services) {
      while (Date.now() < deadline) {
        const ok = await this.healthCheck(service.url);
        if (ok) {
          console.log(`[Health] ${service.name} service is ready`);
          break;
        }
        await this.delay(500);
      }
      if (Date.now() >= deadline) {
        console.warn(`[Health] Timeout waiting for ${service.name} service at ${service.url}`);
      }
    }
  }

  /**
   * 注册所有 IPC 处理器
   */
  registerIpcHandlers(): void {
    registerProcessHandlers({
      goProcess: this.goProcess,
      pythonProcess: this.pythonProcess,
      startGoService: () => this.startGoService(),
      startPythonService: () => this.startPythonService(),
    });
    registerFileHandlers();
    registerConfigHandlers();
  }

  /**
   * 优雅关闭所有子进程
   */
  async cleanup(): Promise<void> {
    const processes = [
      { name: 'Go', proc: this.goProcess },
      { name: 'Python', proc: this.pythonProcess },
    ];

    for (const { name, proc } of processes) {
      if (proc && !proc.killed) {
        console.log(`[Cleanup] Sending SIGTERM to ${name}...`);
        proc.kill('SIGTERM');
      }
    }

    // 等待所有进程退出，最多等 5 秒
    await Promise.all(
      processes.map(({ name, proc }) => {
        if (!proc) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            console.warn(`[Cleanup] Force killing ${name}`);
            proc.kill('SIGKILL');
            resolve();
          }, 5000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      })
    );

    this.goProcess = null;
    this.pythonProcess = null;
  }

  /**
   * 获取 Go 服务二进制路径
   * - 开发模式：packages/server/bin/server
   * - 生产模式：打包后的 resources/server/server
   */
  private getGoServicePath(): string {
    if (isDev) {
      const serverBin = process.platform === 'win32' ? 'server.exe' : 'server';
      return path.join(__dirname, '../../server/bin', serverBin);
    }
    // 生产环境：extraResources 将 server/bin 复制到 resources/server/
    const serverBin = process.platform === 'win32' ? 'server.exe' : 'server';
    return path.join(process.resourcesPath, 'server', serverBin);
  }

  /**
   * 获取 Python 服务路径（使用 cwd 指向 ai-service 目录）
   */
  private getPythonServicePath(): string {
    return 'python';
  }

  private healthCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ──────────────────────────────────────────────────────
// App 生命周期
// ──────────────────────────────────────────────────────
let inkBloom: InkBloomApp;

app.whenReady().then(async () => {
  inkBloom = new InkBloomApp();
  inkBloom.registerIpcHandlers();

  inkBloom.startGoService();
  inkBloom.startPythonService();
  await inkBloom.waitForServices();

  await inkBloom.createWindow();

  app.on('activate', async () => {
    // macOS: 点击 dock 图标时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      await inkBloom.createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (inkBloom) {
    await inkBloom.cleanup();
  }
});
