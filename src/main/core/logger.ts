// The live activity log behind the Updates tab. Every message is redacted before it is
// stored, emitted to the UI or written to disk.
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry, LogLevel, RetailerId, TaskState } from '../../shared/types';
import { redact } from './redact';

const MAX_ENTRIES = 5000;
const KEEP_DAYS = 14;

export interface LogInput {
  level: LogLevel;
  message: string;
  taskId?: string;
  retailer?: RetailerId;
  state?: TaskState;
}

function dayStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatLine(entry: LogEntry): string {
  const task = entry.taskId ? `[task ${entry.taskId.slice(0, 8)}] ` : '';
  const retailer = entry.retailer ? `[${entry.retailer}] ` : '';
  return `${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase().padEnd(7)} ${task}${retailer}${entry.message}\n`;
}

export class LogBus extends EventEmitter {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private dir: string | null = null;
  private pending: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  async init(dir: string): Promise<void> {
    this.dir = dir;
    await mkdir(dir, { recursive: true });
    await this.prune();
  }

  log(input: LogInput): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level: input.level,
      message: redact(input.message),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.retailer ? { retailer: input.retailer } : {}),
      ...(input.state ? { state: input.state } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entry', entry);
    this.pending.push(entry);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 300);
    return entry;
  }

  info(message: string): LogEntry {
    return this.log({ level: 'info', message });
  }

  warn(message: string): LogEntry {
    return this.log({ level: 'warn', message });
  }

  error(message: string): LogEntry {
    return this.log({ level: 'error', message });
  }

  recent(limit: number): LogEntry[] {
    return this.entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
  }

  clear(): void {
    this.entries = [];
    this.emit('cleared');
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (!this.dir || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const byDay = new Map<string, string>();
    for (const entry of batch) {
      const day = dayStamp(entry.ts);
      byDay.set(day, (byDay.get(day) ?? '') + formatLine(entry));
    }
    for (const [day, text] of byDay) {
      try {
        await appendFile(join(this.dir, `aco-${day}.log`), text, 'utf8');
      } catch {
        // Disk problems must never break the app; the in-memory log still works.
      }
    }
  }

  flushSync(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dir || this.pending.length === 0) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const entry of this.pending) appendFileSync(join(this.dir, `aco-${dayStamp(entry.ts)}.log`), formatLine(entry));
    } catch {
      // see flush()
    }
    this.pending = [];
  }

  private async prune(): Promise<void> {
    if (!this.dir) return;
    const cutoff = dayStamp(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    try {
      for (const name of await readdir(this.dir)) {
        const match = /^aco-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
        if (match?.[1] && match[1] < cutoff) await unlink(join(this.dir, name));
      }
    } catch {
      // ignore
    }
  }
}

export const logBus = new LogBus();
