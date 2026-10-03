import { describe, expect, it } from 'vitest';
import { isLegacyPlaceholder, mergeCatalogFeed, sanitizeFeedEntry, untouched } from '../src/main/data/catalogMerge';
import { catalogEntrySchema, catalogFeedEntrySchema, catalogFeedSchema, catalogFileSchema } from '../src/shared/schemas';
import type { CatalogEntry, CatalogFeed } from '../src/shared/types';

type FeedEntry = CatalogFeed['entries'][number];

const noLinks = { target: { url: '', sku: '' }, bestbuy: { url: '', sku: '' }, amazon: { url: '', sku: '' }, pokemoncenter: { url: '', sku: '' } };

function feedEntry(id: string, overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id,
    name: `Product ${id}`,
    category: 'Elite Trainer Box',
    set: 'ME: 30th Celebration',
    tags: [],
    imageUrl: '',
    msrp: 49.99,
    msrpEstimated: true,
    notes: '',
    releaseDate: '2026-09-16',
    tcgplayerId: 704143,
    tcgplayerUrl: 'https://www.tcgplayer.com/product/704143/x',
    market: { price: 155.33, low: 140, change7d: 0.04, change30d: null, updatedAt: '2026-10-03' },
    score: 2,
    retailers: structuredClone(noLinks),
    ...overrides,
  };
}

/** What a synced entry looks like locally after the first sync. */
function firstSync(entries: FeedEntry[]): CatalogEntry[] {
  return mergeCatalogFeed([], entries, new Set(), new Set()).entries;
}

describe('catalog feed merge', () => {
  it('adds new feed products and remembers what the feed said', () => {
    const result = mergeCatalogFeed([], [feedEntry('tcg-1')], new Set(), new Set());
    expect(result.added).toBe(1);
    expect(result.entries[0]?.origin).toBe('feed');
    expect(result.entries[0] && untouched(result.entries[0])).toBe(true);
  });

  it('refreshes prices and untouched fields but keeps the user’s edits', () => {
    const [local] = firstSync([feedEntry('tcg-1')]);
    const edited: CatalogEntry = {
      ...local!,
      msrp: 44.99,
      retailers: { ...local!.retailers, target: { url: 'https://www.target.com/p/x/-/A-1010892076', sku: '' } },
    };
    const next = feedEntry('tcg-1', {
      name: 'Pokémon TCG: 30th Celebration Elite Trainer Box',
      msrp: 49.99,
      market: { price: 170, low: 150, change7d: 0.1, change30d: 0.2, updatedAt: '2026-10-04' },
      retailers: { ...noLinks, bestbuy: { url: 'https://www.bestbuy.com/site/x/13089535.p?skuId=13089535', sku: '' } },
    });
    const { entries, updated } = mergeCatalogFeed([edited], [next], new Set(), new Set());
    const merged = entries[0]!;
    expect(updated).toBe(1);
    expect(merged.name).toBe('Pokémon TCG: 30th Celebration Elite Trainer Box'); // untouched: from the feed
    expect(merged.msrp).toBe(44.99); // edited: kept
    expect(merged.retailers.target.url).toContain('A-1010892076'); // the user's link: kept
    expect(merged.retailers.bestbuy.url).toContain('13089535'); // new feed link: added
    expect(merged.market?.price).toBe(170);
    expect(untouched(merged)).toBe(false);
  });

  it('drops products the feed dropped, unless edited or used by a task', () => {
    const local = firstSync([feedEntry('tcg-1'), feedEntry('tcg-2'), feedEntry('tcg-3')]);
    local[1] = { ...local[1]!, notes: 'my note' };
    const { entries, removed } = mergeCatalogFeed(local, [], new Set(['tcg-3']), new Set());
    expect(removed).toBe(1);
    expect(entries.map((e) => [e.id, e.origin])).toEqual([
      ['tcg-2', 'user'],
      ['tcg-3', 'user'],
    ]);
  });

  it('never brings back an entry the user deleted, and leaves the user’s own entries alone', () => {
    const mine = catalogEntrySchema.parse({ id: 'tcg-9', name: 'My own entry' });
    const { entries, added } = mergeCatalogFeed([mine], [feedEntry('tcg-8'), feedEntry('tcg-9')], new Set(), new Set(['tcg-8']));
    expect(added).toBe(0);
    expect(entries).toEqual([mine]);
  });

  it('removes the 1.0.0 placeholders once real data arrives', () => {
    const placeholder = catalogEntrySchema.parse({ id: 'recent-set-1-etb', name: 'Recent set ETB', notes: 'Placeholder. Fill in links.' });
    expect(isLegacyPlaceholder(placeholder)).toBe(true);
    expect(mergeCatalogFeed([placeholder], [], new Set(), new Set()).entries).toHaveLength(1);
    expect(mergeCatalogFeed([placeholder], [feedEntry('tcg-1')], new Set(), new Set()).entries.map((e) => e.id)).toEqual(['tcg-1']);
    expect(mergeCatalogFeed([placeholder], [feedEntry('tcg-1')], new Set(['recent-set-1-etb']), new Set()).entries).toHaveLength(2);
  });

  it('blanks feed links that do not parse for their store', () => {
    const entry = sanitizeFeedEntry(
      feedEntry('tcg-1', {
        retailers: { ...noLinks, target: { url: 'https://www.bestbuy.com/site/x/123.p', sku: '' }, amazon: { url: '', sku: 'B0H78BB9TY' } },
      }),
    );
    expect(entry.retailers.target.url).toBe('');
    expect(entry.retailers.amazon.sku).toBe('B0H78BB9TY');
  });
});

describe('catalog schemas', () => {
  it('reads 1.0.0 catalog files and fills the new fields with defaults', () => {
    const old = catalogFileSchema.parse({ version: 1, updatedAt: '', entries: [{ id: 'a', name: 'A', retailers: noLinks }] });
    expect(old.dismissed).toEqual([]);
    expect(old.entries[0]).toMatchObject({ origin: 'user', market: null, msrpEstimated: false, releaseDate: '', tcgplayerId: null });
  });

  it('accepts the feed format and rejects foreign links line by line', () => {
    const feed = { version: 1, generatedAt: '2026-10-03T21:17:00Z', source: 'test', entries: [feedEntry('tcg-1'), { id: 'broken' }] };
    expect(catalogFeedSchema.safeParse(feed).success).toBe(true);
    expect(catalogFeedEntrySchema.safeParse(feedEntry('tcg-1')).success).toBe(true);
    expect(catalogFeedEntrySchema.safeParse(feedEntry('tcg-1', { tcgplayerUrl: 'https://evil.example/product/1' })).success).toBe(false);
    expect(catalogFeedEntrySchema.safeParse({ id: 'broken' }).success).toBe(false);
  });
});
