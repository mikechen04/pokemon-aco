import { AbortedError } from './errors';

/** Counting semaphore used for the global concurrency limit. The limit can change at runtime. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(private limit: number) {}

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.pump();
  }

  /** Resolves with a release function once a slot is free. Release is idempotent. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedError());
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      };
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          resolve(release);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) this.waiters.shift()?.grant();
  }
}
