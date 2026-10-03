// JSON persistence with atomic writes and optional encryption at rest.
// Encrypted files start with a header line so plain files (or files written before
// encryption was available) are still readable and get upgraded on the next save.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decryptText, encryptText, encryptionStatus } from './secrets';

const ENCRYPTED_HEADER = 'ACO-ENCRYPTED-V1\n';

export interface StoreOptions<T> {
  path: string;
  defaults: () => T;
  /** Encrypt with the OS key store when available. */
  encrypt: boolean;
  /** Refuse to write at all unless encryption is available (used for account credentials). */
  requireEncryption?: boolean;
  /** Repair or migrate loaded data. Runs on every load. */
  normalize?: (raw: unknown) => T;
  /** Load and save problems are reported here instead of crashing the app. */
  onError?: (message: string) => void;
}

function tempPath(path: string): string {
  return `${path}.${process.pid}.${Date.now()}.tmp`;
}

export class JsonStore<T> {
  private value: T;
  private writeChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly options: StoreOptions<T>) {
    this.value = this.load();
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.scheduleSave();
  }

  update(mutator: (draft: T) => T): T {
    this.set(mutator(this.value));
    return this.value;
  }

  /** Re-read the file from disk (e.g. after the user edited it by hand). */
  reload(): T {
    this.value = this.load();
    return this.value;
  }

  private load(): T {
    const { path, defaults, normalize } = this.options;
    if (!existsSync(path)) return defaults();
    try {
      let text = readFileSync(path, 'utf8');
      if (text.startsWith(ENCRYPTED_HEADER)) text = decryptText(text.slice(ENCRYPTED_HEADER.length).trim());
      const raw: unknown = JSON.parse(text);
      return normalize ? normalize(raw) : (raw as T);
    } catch (err) {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      const backup = `${path}.unreadable-${Date.now()}`;
      try {
        renameSync(path, backup);
      } catch {
        // ignore: nothing else we can do
      }
      this.options.onError?.(
        `Could not read ${path} (${err instanceof Error ? err.message : 'unknown error'}). Moved it to ${backup} and started fresh.`,
      );
      return defaults();
    }
  }

  private serialize(): string {
    const json = JSON.stringify(this.value, null, 2);
    const { encrypt, requireEncryption } = this.options;
    const status = encryptionStatus();
    if ((encrypt || requireEncryption) && status.available) return ENCRYPTED_HEADER + encryptText(json) + '\n';
    if (requireEncryption) throw new Error('OS encryption (DPAPI/Keychain) is not available, refusing to store credentials.');
    return json + '\n';
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.saveNow();
    }, 150);
  }

  /** Serialized async save: writes never interleave, each one is atomic (temp file + rename). */
  saveNow(): Promise<void> {
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    const { path, onError } = this.options;
    let data: string;
    try {
      data = this.serialize();
    } catch (err) {
      onError?.(`Could not save ${path}: ${err instanceof Error ? err.message : 'unknown error'}`);
      return this.writeChain;
    }
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const tmp = tempPath(path);
        await writeFile(tmp, data, 'utf8');
        await rename(tmp, path);
      } catch (err) {
        onError?.(`Could not save ${path}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });
    return this.writeChain;
  }

  /** Synchronous flush for app shutdown. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const { path, onError } = this.options;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = tempPath(path);
      writeFileSync(tmp, this.serialize(), 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      onError?.(`Could not save ${path}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}

/** Write a file atomically (used for exports and the editable catalog). */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}
