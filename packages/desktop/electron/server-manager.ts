/**
 * Embedded Go server lifecycle (task #38, M2-b).
 *
 * Contract from task #37 (M2-a):
 *   env: INKBLOOM_MODE=local, INKBLOOM_SERVER_DATA_ROOT, INKBLOOM_SERVER_WEB_DIST
 *   readiness: GET http://127.0.0.1:18080/health -> 200
 *
 * Behavior:
 *  - spawn with stdout/stderr appended to <dataRoot>/logs/server.log
 *  - cwd = data root (so no stray config.yaml is picked up; env rules)
 *  - crash guard: auto-restart up to MAX_RESTARTS, then surface an error
 *  - stop(): kill child on app quit / window-all-closed
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { SERVER_PORT, getServerBinaryPath, getWebDistPath, getLogDir } from './paths';

export interface ServerManagerOptions {
  dataRoot: string;
  /** Optional port override; defaults to the packaged 18080 contract. */
  port?: number;
  /** Called when the child exits unexpectedly (crash hook for the shell). */
  onUnexpectedExit?: (code: number | null, restarted: boolean) => void;
}

const MAX_RESTARTS = 3;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 300;

export class EmbeddedServer {
  private child: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private stopping = false;
  private restarts = 0;
  private readonly opts: ServerManagerOptions;
  private readonly port: number;

  constructor(opts: ServerManagerOptions) {
    this.opts = opts;
    this.port = opts.port ?? SERVER_PORT;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** Spawn the server and wait until /health answers 200. */
  async start(): Promise<void> {
    this.spawn();
    await this.waitForReady();
  }

  /** Restart the child process (used by IPC and the crash dialog). */
  async restart(): Promise<void> {
    await this.killChild();
    this.spawn();
    await this.waitForReady();
  }

  /** Kill the child (idempotent). Windows: taskkill via proc.kill(). */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.killChild();
    this.logStream?.end();
    this.logStream = null;
  }

  // ── internals ────────────────────────────────────────────────────────

  private spawn(): void {
    const binPath = getServerBinaryPath();
    if (!fs.existsSync(binPath)) {
      throw new Error(
        `embedded server binary not found: ${binPath}\n` +
          'Dev hint: run "npm run build:server" inside packages/desktop first.'
      );
    }

    const dataRoot = path.resolve(this.opts.dataRoot);
    fs.mkdirSync(getLogDir(dataRoot), { recursive: true });
    this.logStream = fs.createWriteStream(path.join(getLogDir(dataRoot), 'server.log'), {
      flags: 'a',
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INKBLOOM_MODE: 'local',
      INKBLOOM_SERVER_DATA_ROOT: dataRoot,
      INKBLOOM_SERVER_WEB_DIST: getWebDistPath(),
      INKBLOOM_SERVER_PORT: String(this.port),
    };

    // cwd = data root: no config.yaml there, so env-only configuration is
    // deterministic in both dev and packaged runs.
    this.child = spawn(binPath, [], { cwd: dataRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const tee = (chunk: Buffer): void => {
      this.logStream?.write(chunk);
      process.stdout.write(`[server] ${chunk}`);
    };
    this.child.stdout?.on('data', tee);
    this.child.stderr?.on('data', tee);

    this.child.on('error', (err: Error) => {
      console.error('[desktop] embedded server failed to start:', err.message);
    });

    this.child.on('exit', (code, signal) => {
      const wasRunning = this.child !== null;
      this.child = null;
      console.log(`[desktop] embedded server exited (code=${code}, signal=${signal})`);
      if (this.stopping || !wasRunning) {
        return;
      }
      // Crash guard (plan 1.1): auto-restart at most MAX_RESTARTS times.
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        console.warn(`[desktop] server crashed, auto-restart ${this.restarts}/${MAX_RESTARTS}`);
        this.opts.onUnexpectedExit?.(code, true);
        try {
          this.spawn();
          void this.waitForReady().catch((err: Error) => {
            console.error('[desktop] post-restart readiness failed:', err.message);
          });
          return;
        } catch (err) {
          console.error('[desktop] respawn failed:', err);
        }
      }
      this.opts.onUnexpectedExit?.(code, false);
    });
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.stopping) {
        throw new Error('server startup aborted');
      }
      if (await this.healthCheck()) {
        console.log('[desktop] embedded server ready at', this.url);
        return;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(
      `embedded server did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s ` +
        `(see ${path.join(getLogDir(this.opts.dataRoot), 'server.log')})`
    );
  }

  private healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${this.url}/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[desktop] force killing embedded server');
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
