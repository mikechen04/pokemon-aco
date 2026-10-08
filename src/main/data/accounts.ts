// Retailer logins. The whole file is encrypted with the OS key store (DPAPI on Windows)
// and the app refuses to write it unencrypted. Passwords never leave the main process.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseAccountLines } from '../../shared/accountLines';
import { RETAILERS } from '../../shared/retailers';
import type {
  AccountEditable,
  AccountInput,
  AccountPublic,
  AccountSessionState,
  BulkAccountInput,
  BulkAccountResult,
  RetailerId,
} from '../../shared/types';
import { JsonStore } from '../core/fileStore';
import { paths } from '../core/paths';
import { forgetSecret, maskEmail, registerSecret } from '../core/redact';
import { encryptionStatus } from '../core/secrets';
import { isRetailerId } from './normalize';

export interface AccountRecord {
  id: string;
  createdAt: number;
  retailer: RetailerId;
  label: string;
  email: string;
  password: string;
  twoFactorNote: string;
  /** Default checkout profile for this account. */
  profileId: string;
}

interface AccountsFile {
  version: 1;
  accounts: AccountRecord[];
}

interface SessionStatus {
  state: AccountSessionState;
  message: string;
  checkedAt?: number;
}

function normalizeFile(raw: unknown): AccountsFile {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { accounts?: unknown }).accounts)
    ? (raw as { accounts: unknown[] }).accounts
    : [];
  const accounts: AccountRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !isRetailerId(a.retailer) || typeof a.email !== 'string') continue;
    accounts.push({
      id: a.id,
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
      retailer: a.retailer,
      label: typeof a.label === 'string' ? a.label : a.email,
      email: a.email,
      password: typeof a.password === 'string' ? a.password : '',
      twoFactorNote: typeof a.twoFactorNote === 'string' ? a.twoFactorNote : '',
      profileId: typeof a.profileId === 'string' ? a.profileId : '',
    });
  }
  return { version: 1, accounts };
}

function registerAccountSecrets(account: AccountRecord): void {
  registerSecret(account.password);
  registerSecret(account.email);
  registerSecret(account.twoFactorNote);
}

function forgetAccountSecrets(account: AccountRecord): void {
  forgetSecret(account.password);
  forgetSecret(account.email);
  forgetSecret(account.twoFactorNote);
}

export class AccountsRepo extends EventEmitter {
  private readonly store: JsonStore<AccountsFile>;
  private readonly sessions = new Map<string, SessionStatus>();

  constructor(onError: (message: string) => void) {
    super();
    this.store = new JsonStore<AccountsFile>({
      path: paths.dataFile('accounts.json'),
      defaults: () => ({ version: 1, accounts: [] }),
      encrypt: true,
      requireEncryption: true,
      normalize: normalizeFile,
      onError,
    });
    for (const account of this.store.get().accounts) registerAccountSecrets(account);
  }

  private toPublic(account: AccountRecord): AccountPublic {
    const session = this.sessions.get(account.id) ?? { state: 'unknown', message: 'Not checked yet' };
    return {
      id: account.id,
      createdAt: account.createdAt,
      retailer: account.retailer,
      label: account.label,
      emailMasked: maskEmail(account.email),
      hasPassword: account.password.length > 0,
      hasTwoFactorNote: account.twoFactorNote.length > 0,
      ...(account.profileId ? { profileId: account.profileId } : {}),
      session: session.state,
      sessionMessage: session.message,
      ...(session.checkedAt ? { sessionCheckedAt: session.checkedAt } : {}),
    };
  }

  private assertEncryption(): void {
    if (!encryptionStatus().available) {
      throw new Error('Windows DPAPI / OS encryption is not available, so accounts cannot be saved safely.');
    }
  }

  list(): AccountPublic[] {
    return this.store.get().accounts.map((a) => this.toPublic(a));
  }

  publicView(id: string): AccountPublic | undefined {
    const account = this.get(id);
    return account ? this.toPublic(account) : undefined;
  }

  /** Main-process only: includes the decrypted credentials. */
  get(id: string): AccountRecord | undefined {
    return this.store.get().accounts.find((a) => a.id === id);
  }

  editable(id: string): AccountEditable {
    const account = this.get(id);
    if (!account) throw new Error('Account not found');
    return {
      id: account.id,
      retailer: account.retailer,
      label: account.label,
      email: account.email,
      twoFactorNote: account.twoFactorNote,
      hasPassword: account.password.length > 0,
      profileId: account.profileId,
    };
  }

  /** `id` lets a caller pick the id up front (its isolated session is named after it). */
  create(input: AccountInput, id: string = randomUUID()): AccountPublic {
    this.assertEncryption();
    const account: AccountRecord = {
      id,
      createdAt: Date.now(),
      retailer: input.retailer,
      label: input.label,
      email: input.email.trim(),
      password: input.password ?? '',
      twoFactorNote: input.twoFactorNote ?? '',
      profileId: input.profileId ?? '',
    };
    registerAccountSecrets(account);
    this.store.update((file) => ({ ...file, accounts: [...file.accounts, account] }));
    this.emitList();
    return this.toPublic(account);
  }

  /** Adds many accounts at once from "email:password" lines. Skips logins already saved. */
  createMany(input: BulkAccountInput): BulkAccountResult {
    this.assertEncryption();
    const parsed = parseAccountLines(input.text);
    const existing = new Set(
      this.store
        .get()
        .accounts.filter((a) => a.retailer === input.retailer)
        .map((a) => a.email.toLowerCase()),
    );
    const prefix = input.labelPrefix?.trim() || RETAILERS[input.retailer].name;
    const sameRetailer = this.store.get().accounts.filter((a) => a.retailer === input.retailer).length;
    const created: AccountRecord[] = [];
    let skipped = parsed.duplicates;
    for (const entry of parsed.entries) {
      if (existing.has(entry.email.toLowerCase())) {
        skipped++;
        continue;
      }
      existing.add(entry.email.toLowerCase());
      created.push({
        id: randomUUID(),
        createdAt: Date.now(),
        retailer: input.retailer,
        label: `${prefix} #${sameRetailer + created.length + 1}`,
        email: entry.email,
        password: entry.password,
        twoFactorNote: '',
        profileId: input.profileId ?? '',
      });
    }
    if (created.length) {
      for (const account of created) registerAccountSecrets(account);
      this.store.update((file) => ({ ...file, accounts: [...file.accounts, ...created] }));
      this.emitList();
    }
    return { created: created.length, skipped, errors: parsed.errors };
  }

  update(id: string, input: AccountInput): AccountPublic {
    this.assertEncryption();
    const existing = this.get(id);
    if (!existing) throw new Error('Account not found');
    const next: AccountRecord = {
      ...existing,
      retailer: input.retailer,
      label: input.label,
      email: input.email.trim(),
      password: input.password ? input.password : existing.password,
      twoFactorNote: input.twoFactorNote ?? '',
      profileId: input.profileId ?? '',
    };
    forgetAccountSecrets(existing);
    registerAccountSecrets(next);
    this.store.update((file) => ({ ...file, accounts: file.accounts.map((a) => (a.id === id ? next : a)) }));
    // A different login means the old session status no longer applies.
    if (existing.email !== next.email || existing.retailer !== next.retailer) this.sessions.delete(id);
    this.emitList();
    return this.toPublic(next);
  }

  remove(ids: string[]): number {
    const set = new Set(ids);
    const removed = this.store.get().accounts.filter((a) => set.has(a.id));
    if (removed.length === 0) return 0;
    for (const account of removed) {
      forgetAccountSecrets(account);
      this.sessions.delete(account.id);
    }
    this.store.update((file) => ({ ...file, accounts: file.accounts.filter((a) => !set.has(a.id)) }));
    this.emitList();
    return removed.length;
  }

  /** Clears the default profile on accounts that pointed at a deleted profile. */
  forgetProfile(profileId: string): void {
    if (!this.store.get().accounts.some((a) => a.profileId === profileId)) return;
    this.store.update((file) => ({
      ...file,
      accounts: file.accounts.map((a) => (a.profileId === profileId ? { ...a, profileId: '' } : a)),
    }));
    this.emitList();
  }

  setSession(id: string, state: AccountSessionState, message: string): void {
    const account = this.get(id);
    if (!account) return;
    // "checking" keeps the time of the last finished check.
    const checkedAt = state === 'checking' ? this.sessions.get(id)?.checkedAt : Date.now();
    this.sessions.set(id, { state, message, checkedAt });
    this.emit('account', this.toPublic(account));
  }

  sessionState(id: string): AccountSessionState {
    return this.sessions.get(id)?.state ?? 'unknown';
  }

  private emitList(): void {
    this.emit('changed', this.list());
  }

  flush(): void {
    this.store.flushSync();
  }
}
