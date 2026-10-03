// The product catalog: a plain, human-editable JSON file in the user data folder. It is seeded
// from catalog/default-catalog.json and kept current from the catalog feed (catalog/feed.json,
// rebuilt daily from TCGplayer prices by this repo's catalog-feed workflow).
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { net } from 'electron';
import defaultCatalog from '../../../catalog/default-catalog.json';
import { catalogFeedSchema, catalogFileSchema, firstIssue } from '../../shared/schemas';
import type { CatalogEntry, CatalogFeedState, CatalogFile, CatalogImportResult, CatalogSyncResult } from '../../shared/types';
import { writeFileAtomic } from '../core/fileStore';
import { paths } from '../core/paths';
import { mergeCatalogFeed, sanitizeFeedEntry } from './catalogMerge';

/** A feed bigger than this is refused (today's is well under 1 MB). */
const MAX_FEED_BYTES = 10 * 1024 * 1024;

function seed(): CatalogFile {
  const parsed = catalogFileSchema.safeParse(defaultCatalog);
  if (!parsed.success) throw new Error(`Bundled catalog is invalid: ${firstIssue(parsed.error)}`);
  return { ...parsed.data, updatedAt: new Date().toISOString() };
}

function dedupe(entries: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

export class CatalogRepo extends EventEmitter {
  private file: CatalogFile;
  private syncing: Promise<CatalogSyncResult> | null = null;

  constructor(private readonly onError: (message: string) => void) {
    super();
    this.file = this.loadOrSeed();
  }

  private loadOrSeed(): CatalogFile {
    const path = paths.catalog;
    if (!existsSync(path)) {
      const seeded = seed();
      void this.write(seeded);
      return seeded;
    }
    try {
      const parsed = catalogFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return { ...parsed.data, entries: dedupe(parsed.data.entries) };
      this.onError(`catalog.json has a problem (${firstIssue(parsed.error)}). Fix it and press Reload, or it will be replaced on the next save.`);
    } catch (err) {
      const backup = `${path}.unreadable-${Date.now()}`;
      try {
        renameSync(path, backup);
      } catch {
        // ignore
      }
      this.onError(`catalog.json is not valid JSON (${err instanceof Error ? err.message : 'unknown'}). Moved it to ${backup}.`);
    }
    return seed();
  }

  private async write(file: CatalogFile): Promise<void> {
    try {
      await writeFileAtomic(paths.catalog, JSON.stringify(file, null, 2) + '\n');
    } catch (err) {
      this.onError(`Could not save catalog.json: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  private commit(entries: CatalogEntry[], changes: { feed?: CatalogFeedState; dismissed?: string[] } = {}): CatalogFile {
    this.file = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...((changes.feed ?? this.file.feed) ? { feed: changes.feed ?? this.file.feed } : {}),
      dismissed: changes.dismissed ?? this.file.dismissed,
      entries: dedupe(entries),
    };
    void this.write(this.file);
    this.emit('changed', this.file);
    return this.file;
  }

  get(): CatalogFile {
    return this.file;
  }

  find(id: string): CatalogEntry | undefined {
    return this.file.entries.find((e) => e.id === id);
  }

  /** `entry` must already be validated with catalogEntrySchema. */
  upsert(entry: CatalogEntry): CatalogFile {
    const exists = this.file.entries.some((e) => e.id === entry.id);
    const entries = exists
      ? this.file.entries.map((e) => (e.id === entry.id ? entry : e))
      : [...this.file.entries, entry];
    return this.commit(entries);
  }

  remove(id: string): CatalogFile {
    const entry = this.find(id);
    // A deleted feed entry stays deleted: sync does not bring it back.
    const dismissed = entry?.origin === 'feed' && !this.file.dismissed.includes(id) ? [...this.file.dismissed, id] : this.file.dismissed;
    return this.commit(
      this.file.entries.filter((e) => e.id !== id),
      { dismissed },
    );
  }

  reload(): CatalogFile {
    this.file = this.loadOrSeed();
    this.emit('changed', this.file);
    return this.file;
  }

  /**
   * Downloads the catalog feed and merges it in. Concurrent calls share one download.
   * @param keepIds entries that tasks refer to (never removed).
   */
  sync(url: string, keepIds: Set<string>): Promise<CatalogSyncResult> {
    this.syncing ??= this.doSync(url, keepIds).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(url: string, keepIds: Set<string>): Promise<CatalogSyncResult> {
    const total = this.file.entries.length;
    const fail = (message: string): CatalogSyncResult => ({ ok: false, message, added: 0, updated: 0, removed: 0, total });
    if (!/^https:\/\//i.test(url)) return fail('The catalog feed URL must start with https://');
    let text: string;
    try {
      const res = await net.fetch(url, { headers: { accept: 'application/json' }, cache: 'no-cache' });
      if (res.status === 404) return fail('The catalog feed is not published at that address yet (HTTP 404)');
      if (!res.ok) return fail(`The catalog feed answered HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      return fail(`Could not download the catalog feed (${err instanceof Error ? err.message : 'network error'})`);
    }
    if (text.length > MAX_FEED_BYTES) return fail('The catalog feed is too large');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail('The catalog feed is not valid JSON');
    }
    const parsed = catalogFeedSchema.safeParse(raw);
    if (!parsed.success) return fail(`The catalog feed is invalid: ${firstIssue(parsed.error)}`);
    const feed = parsed.data;
    const merged = mergeCatalogFeed(this.file.entries, feed.entries.map(sanitizeFeedEntry), keepIds, new Set(this.file.dismissed));
    const file = this.commit(merged.entries, {
      feed: { url, syncedAt: new Date().toISOString(), generatedAt: feed.generatedAt, source: feed.source },
    });
    const parts = [
      merged.added ? `${merged.added} new` : '',
      merged.updated ? `${merged.updated} updated` : '',
      merged.removed ? `${merged.removed} removed` : '',
    ].filter(Boolean);
    return {
      ok: true,
      message: `Catalog synced: ${parts.length ? parts.join(', ') : 'no changes'} (${file.entries.length} entries)`,
      added: merged.added,
      updated: merged.updated,
      removed: merged.removed,
      total: file.entries.length,
    };
  }

  async importFrom(path: string, mode: 'merge' | 'replace'): Promise<CatalogImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      return { ok: false, message: `Not valid JSON: ${err instanceof Error ? err.message : 'unknown'}`, added: 0, updated: 0, total: this.file.entries.length };
    }
    // Accept either a full catalog file or a bare array of entries.
    const candidate = Array.isArray(raw) ? { version: 1, entries: raw } : raw;
    const parsed = catalogFileSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, message: `Catalog file is invalid: ${firstIssue(parsed.error)}`, added: 0, updated: 0, total: this.file.entries.length };
    }
    const incoming = dedupe(parsed.data.entries);
    if (mode === 'replace') {
      const file = this.commit(incoming);
      return { ok: true, message: `Replaced the catalog with ${incoming.length} entries.`, added: incoming.length, updated: 0, total: file.entries.length };
    }
    const existingIds = new Set(this.file.entries.map((e) => e.id));
    const updated = incoming.filter((e) => existingIds.has(e.id)).length;
    const added = incoming.length - updated;
    const merged = new Map(this.file.entries.map((e) => [e.id, e]));
    for (const entry of incoming) merged.set(entry.id, entry);
    const file = this.commit([...merged.values()]);
    return { ok: true, message: `Imported ${added} new and ${updated} updated entries.`, added, updated, total: file.entries.length };
  }

  async exportTo(path: string): Promise<void> {
    await writeFileAtomic(path, JSON.stringify(this.file, null, 2) + '\n');
  }
}
