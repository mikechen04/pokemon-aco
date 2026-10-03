import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bestStoreMatch,
  buildEntry,
  changeSince,
  classify,
  curatedLinksFor,
  isSealed,
  pruneHistory,
  resultsOf,
  selectEntries,
  type CuratedLink,
  type MsrpSource,
  type PriceHistory,
  type TcgProduct,
} from '../scripts/catalog/feedLib';
import { mergeCatalogFeed } from '../src/main/data/catalogMerge';
import { catalogEntryProblems, catalogFeedSchema, catalogFileSchema } from '../src/shared/schemas';

const msrp = JSON.parse(readFileSync('catalog/sources/msrp.json', 'utf8')) as MsrpSource;
const links = (JSON.parse(readFileSync('catalog/sources/links.json', 'utf8')) as { links: CuratedLink[] }).links;
const group = { groupId: 24500, name: 'ME: 30th Celebration', abbreviation: 'ME30', publishedOn: '2026-09-16T00:00:00' };
const etb: TcgProduct = { productId: 704143, name: '30th Celebration Elite Trainer Box', groupId: 24500, url: 'https://www.tcgplayer.com/product/704143/pokemon-x', imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/704143_200w.jpg', extendedData: [] };
const card: TcgProduct = { productId: 1, name: 'Pikachu ex', groupId: 24500, extendedData: [{ name: 'Number', value: '025/191' }, { name: 'Rarity', value: 'Double Rare' }] };

describe('catalog feed builder', () => {
  it('unwraps TCGCSV responses and keeps only retail sealed products', () => {
    expect(resultsOf<number>({ success: true, errors: [], results: [1, 2] })).toEqual([1, 2]);
    expect(resultsOf<number>([3])).toEqual([3]);
    expect(resultsOf<number>(null)).toEqual([]);
    expect(isSealed(etb)).toBe(true);
    expect(isSealed(card)).toBe(false);
    expect(isSealed({ ...etb, name: '30th Celebration Elite Trainer Box Case' })).toBe(false);
    expect(isSealed({ ...etb, name: 'Code Card - 30th Celebration Booster Pack' })).toBe(false);
  });

  it('knows product types and their usual retail price', () => {
    expect(classify('30th Celebration Pokemon Center Elite Trainer Box', msrp)).toEqual({ category: 'Pokémon Center Exclusive', msrp: 59.99 });
    expect(classify('Surging Sparks Booster Bundle', msrp)).toEqual({ category: 'Booster Bundle', msrp: 26.94 });
    expect(classify('Surging Sparks Booster Box', msrp).msrp).toBe(161.64);
    expect(classify('Mini Tin [Pikachu]', msrp).category).toBe('Tin');
    expect(classify('Ditto Premium Collection', msrp)).toEqual({ category: 'Collection Box', msrp: null });
  });

  it('builds an entry with margin, links, release date and price changes', () => {
    const history: PriceHistory = { version: 1, prices: { '704143': { '2026-09-26': 140, '2026-09-03': 100 } } };
    const entry = buildEntry({ product: etb, group, prices: [{ productId: 704143, lowPrice: 149, midPrice: 160, marketPrice: 154, subTypeName: 'Normal' }], msrp, links, history, today: '2026-10-03' });
    expect(entry).toMatchObject({ id: 'tcg-704143', category: 'Elite Trainer Box', set: '30th Celebration', msrp: 49.99, msrpEstimated: false, releaseDate: '2026-09-16' });
    expect(entry.market).toMatchObject({ price: 154, low: 149, change7d: 0.1, change30d: 0.54 });
    expect(entry.retailers.target.url).toContain('A-1010892076');
    expect(entry.retailers.bestbuy.url).toContain('13089535');
    expect(entry.score).toBeGreaterThan(2);
    // The entry must be valid for the app, links included.
    expect(catalogFeedSchema.safeParse({ version: 1, generatedAt: 'x', entries: [entry] }).success).toBe(true);
    expect(catalogEntryProblems({ ...entry, origin: 'feed' })).toEqual([]);
  });

  it('matches hand-checked links by id or by name words', () => {
    expect(curatedLinksFor({ ...etb, productId: 999, name: '30th Celebration Booster Bundle' }, links).bestbuy).toContain('JJG2TL8X2V');
    expect(curatedLinksFor({ ...etb, productId: 998, name: '30th Celebration Booster Bundle Display' }, links).bestbuy).toBeUndefined();
  });

  it('computes changes from the recorded history and forgets old days', () => {
    const history: PriceHistory = { version: 1, prices: { '5': { '2026-10-03': 110, '2026-09-27': 100, '2026-08-01': 50 } } };
    expect(changeSince(history, 5, '2026-10-03', 7)).toBe(0.1); // 6 days back is within the ±2 window
    expect(changeSince(history, 5, '2026-10-03', 30)).toBeNull();
    pruneHistory(history, '2026-10-03');
    expect(Object.keys(history.prices['5'] ?? {})).toEqual(['2026-10-03', '2026-09-27']);
  });

  it('picks only the store listing that is clearly the same product', () => {
    const hits = [
      { id: '1', title: 'Pokémon Trading Card Game: Scarlet & Violet—Surging Sparks Elite Trainer Box', url: 'u1', price: 49.99 },
      { id: '2', title: 'Pokémon TCG: Surging Sparks Pokémon Center Elite Trainer Box', url: 'u2', price: 59.99 },
      { id: '3', title: 'Pokémon TCG: Surging Sparks Booster Bundle', url: 'u3', price: 26.94 },
      { id: '4', title: 'Pokémon TCG: Surging Sparks Elite Trainer Box Case of 10', url: 'u4', price: 499.9 },
    ];
    expect(bestStoreMatch('Surging Sparks Elite Trainer Box', 'Surging Sparks', 49.99, hits)?.id).toBe('1');
    expect(bestStoreMatch('Surging Sparks Pokemon Center Elite Trainer Box', 'Surging Sparks', 59.99, hits)?.id).toBe('2');
    expect(bestStoreMatch('Surging Sparks Elite Trainer Box', 'Surging Sparks', 49.99, [{ ...hits[0]!, price: 4.99 }])).toBeNull();
    expect(bestStoreMatch('Elite Trainer Box', 'Prismatic Evolutions', 49.99, hits)).toBeNull();
  });

  it('keeps linked and upcoming products, then the best scores', () => {
    const base = buildEntry({ product: etb, group, prices: [], msrp, links: [], history: { version: 1, prices: {} }, today: '2026-10-03' });
    const make = (id: string, score: number | null, extra: object = {}) => ({ ...base, id, score, market: score === null ? null : base.market ?? { price: 1, low: 1, change7d: null, change30d: null, updatedAt: '' }, ...extra });
    const upcoming = make('up', null, { releaseDate: '2026-11-06' });
    const stale = make('stale', null);
    const picked = selectEntries([make('a', 1), make('b', 3), upcoming, stale, make('c', 2)], '2026-10-03', 3);
    expect(picked.map((e) => e.id)).toEqual(['b', 'c', 'up']);
  });
});

describe('shipped catalog data', () => {
  it('seeds a valid catalog whose store links all parse', () => {
    const seed = catalogFileSchema.parse(JSON.parse(readFileSync('catalog/default-catalog.json', 'utf8')));
    expect(seed.entries.length).toBeGreaterThan(0);
    for (const entry of seed.entries) expect(catalogEntryProblems(entry)).toEqual([]);
    // Seed entries are feed entries: the first sync updates or replaces them instead of duplicating.
    expect(seed.entries.every((e) => e.origin === 'feed' && e.feedBase)).toBe(true);
    const synced = mergeCatalogFeed(seed.entries, [], new Set(), new Set());
    expect(synced.removed).toBe(seed.entries.length);
  });

  it('only lists hand-checked links that parse for their store', () => {
    for (const link of links) {
      for (const id of ['target', 'bestbuy', 'amazon', 'pokemoncenter'] as const) {
        const url = link[id];
        if (url) expect(catalogEntryProblems(catalogFileSchema.parse({ entries: [{ id: 'x', name: 'x', retailers: { [id]: { url } } }] }).entries[0]!)).toEqual([]);
      }
    }
  });
});
