// Merges the catalog feed into the local catalog. No Electron imports, so it is unit tested.
//
// - New feed products are added (unless the user deleted them before).
// - Feed entries are refreshed: prices, ranking and release dates always; editable fields
//   (name, MSRP, notes, store links, ...) only where the user has not changed them. The feed's
//   previous values are kept in `feedBase` to tell the two apart (a three-way merge).
// - Products the feed dropped are removed if untouched and not used by a task; otherwise they
//   stay as the user's own entries.
// - The placeholders shipped with version 1.0.0 are removed once real data arrives.
import { parseProductInput } from '../../shared/retailers';
import { RETAILER_IDS, type CatalogEntry, type CatalogFeed, type CatalogFeedBase } from '../../shared/types';

type FeedEntry = CatalogFeed['entries'][number];

const EDITABLE = ['name', 'category', 'set', 'tags', 'imageUrl', 'msrp', 'msrpEstimated', 'notes'] as const;

/** Ids of the empty placeholder entries that version 1.0.0 shipped with. */
const LEGACY_PLACEHOLDER_IDS = new Set([
  '30th-celebration-etb',
  '30th-celebration-pc-etb',
  '30th-celebration-booster-bundle',
  '30th-celebration-collection',
  'recent-set-1-etb',
  'recent-set-1-pc-etb',
  'recent-set-1-booster-bundle',
  'recent-set-2-etb',
  'recent-set-2-booster-bundle',
  'pokemon-center-exclusive-1',
]);

/** Key order does not matter (files are re-serialized by hand and by the schema). */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, stable(obj[key])]));
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

function baseOf(entry: CatalogFeedBase): CatalogFeedBase {
  return structuredClone({
    name: entry.name,
    category: entry.category,
    set: entry.set,
    tags: entry.tags,
    imageUrl: entry.imageUrl,
    msrp: entry.msrp,
    msrpEstimated: entry.msrpEstimated,
    notes: entry.notes,
    retailers: entry.retailers,
  });
}

/** True when nothing the user can edit differs from what the feed last said. */
export function untouched(entry: CatalogEntry): boolean {
  return entry.feedBase !== undefined && same(baseOf(entry), entry.feedBase);
}

function hasLinks(entry: CatalogEntry): boolean {
  return RETAILER_IDS.some((id) => entry.retailers[id].url || entry.retailers[id].sku);
}

export function isLegacyPlaceholder(entry: CatalogEntry): boolean {
  return entry.origin === 'user' && LEGACY_PLACEHOLDER_IDS.has(entry.id) && entry.notes.startsWith('Placeholder.') && !hasLinks(entry) && entry.msrp === null;
}

/** Blanks store links that do not parse for their store, so a bad feed line cannot create a bad task. */
export function sanitizeFeedEntry(entry: FeedEntry): FeedEntry {
  const retailers = structuredClone(entry.retailers);
  for (const id of RETAILER_IDS) {
    const ref = retailers[id];
    const value = ref.url || ref.sku;
    if (value && !parseProductInput(id, value).ok) retailers[id] = { url: '', sku: '' };
  }
  return { ...entry, retailers };
}

export interface MergeOutcome {
  entries: CatalogEntry[];
  added: number;
  updated: number;
  removed: number;
}

/**
 * @param keepIds catalog entries that tasks refer to; never removed.
 * @param dismissed feed entries the user deleted; never re-added.
 */
export function mergeCatalogFeed(local: CatalogEntry[], feed: FeedEntry[], keepIds: Set<string>, dismissed: Set<string>): MergeOutcome {
  const feedById = new Map(feed.map((entry) => [entry.id, entry]));
  const localIds = new Set(local.map((entry) => entry.id));
  const entries: CatalogEntry[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const entry of local) {
    if (entry.origin !== 'feed') {
      if (isLegacyPlaceholder(entry) && !keepIds.has(entry.id) && feed.length > 0) {
        removed++;
        continue;
      }
      entries.push(entry); // the user's own entry; a feed entry with the same id is ignored
      continue;
    }
    const incoming = feedById.get(entry.id);
    if (!incoming) {
      if (untouched(entry) && !keepIds.has(entry.id)) {
        removed++;
        continue;
      }
      const { feedBase: _base, ...rest } = entry;
      entries.push({ ...rest, origin: 'user' });
      updated++;
      continue;
    }
    const base = entry.feedBase ?? baseOf(entry);
    const next: CatalogEntry = structuredClone(entry);
    for (const key of EDITABLE) {
      if (same(entry[key], base[key])) (next as unknown as Record<string, unknown>)[key] = structuredClone(incoming[key]);
    }
    for (const id of RETAILER_IDS) {
      if (same(entry.retailers[id], base.retailers[id])) next.retailers[id] = { ...incoming.retailers[id] };
    }
    next.releaseDate = incoming.releaseDate;
    next.tcgplayerId = incoming.tcgplayerId;
    next.tcgplayerUrl = incoming.tcgplayerUrl;
    next.market = incoming.market;
    next.score = incoming.score;
    next.feedBase = baseOf(incoming);
    if (!same(next, entry)) updated++;
    entries.push(next);
  }

  for (const incoming of feed) {
    if (localIds.has(incoming.id) || dismissed.has(incoming.id)) continue;
    entries.push({ ...structuredClone(incoming), origin: 'feed', feedBase: baseOf(incoming) });
    added++;
  }
  return { entries, added, updated, removed };
}
