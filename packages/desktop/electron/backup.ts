/**
 * Backup scheduler (task #38, M2-b; product plan 1.3).
 *
 * Strategy:
 *  - Startup: if the newest snapshot on disk is older than 24h (or none
 *    exists), request a fresh snapshot.
 *  - Daily: one snapshot at 03:00 while the app keeps running.
 *
 * Snapshots themselves are produced by the embedded server's checkpoint
 * endpoint (POST /api/v1/system/backup -> SQLite `VACUUM INTO`, a
 * consistent online snapshot that never blocks writers). Retention
 * (7 daily + 3 monthly) is enforced server-side after each snapshot.
 */
import * as http from 'http';

interface BackupInfo {
  name: string;
  created_at: string;
  size_bytes: number;
}

const STARTUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DAILY_HOUR = 3; // 03:00 local time (plan 1.3)

export class BackupScheduler {
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly baseUrl: string) {}

  /** Startup snapshot when the last one is older than 24 hours. */
  async maybeStartupBackup(): Promise<void> {
    try {
      const latest = await this.latestBackup();
      if (latest) {
        const age = Date.now() - new Date(latest.created_at).getTime();
        if (age < STARTUP_MAX_AGE_MS) {
          console.log(`[backup] fresh enough, skipping startup snapshot (${latest.name})`);
          return;
        }
      }
      await this.createBackup('startup');
    } catch (err) {
      console.error('[backup] startup backup failed:', err);
    }
  }

  /** Schedule the daily 03:00 snapshot; re-arms itself after each run. */
  scheduleDaily(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
    }
    const now = new Date();
    const next = new Date(now);
    next.setHours(DAILY_HOUR, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    console.log(`[backup] daily snapshot scheduled at ${next.toLocaleString()}`);
    this.dailyTimer = setTimeout(() => {
      void this.createBackup('daily')
        .catch((err: Error) => console.error('[backup] daily backup failed:', err))
        .finally(() => this.scheduleDaily());
    }, delay);
    // Do not keep the app alive just for the backup timer.
    this.dailyTimer.unref?.();
  }

  stop(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private async latestBackup(): Promise<BackupInfo | null> {
    const data = await this.request<BackupInfo[]>('GET', '/api/v1/system/backups');
    return data && data.length > 0 ? data[0] : null;
  }

  private async createBackup(reason: string): Promise<void> {
    const data = await this.request<{ name: string; size_bytes: number; retained: number }>(
      'POST',
      '/api/v1/system/backup'
    );
    console.log(
      `[backup] ${reason} snapshot created: ${data?.name} (${data?.size_bytes} bytes, retained=${data?.retained})`
    );
  }

  private request<T>(method: 'GET' | 'POST', urlPath: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${this.baseUrl}${urlPath}`,
        { method, headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => {
            try {
              const envelope = JSON.parse(body) as { code: number; data?: T };
              if (res.statusCode !== 200 && res.statusCode !== 201) {
                reject(new Error(`backup endpoint ${urlPath} -> HTTP ${res.statusCode}: ${body}`));
                return;
              }
              resolve(envelope.data ?? null);
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`backup request timeout: ${urlPath}`));
      });
      req.end();
    });
  }
}
