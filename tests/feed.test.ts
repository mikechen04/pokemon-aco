import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bestStoreMatch,
  buildEntry,
  changeSince,
  classify,
  curatedLinksFor,
  isMiscGroup,
  isSealed,
  isSetGroup,
  pruneHistory,
  recentIdThreshold,
  scoreOf,
  resultsOf,
  selectEntries,
  type CuratedLink,
  type MsrpSource,
  type PriceHistory,
  type TcgProduct,
} from '../scripts/catalog/feedLib';
import { mergeCatalogFeed } from '../src/main/data/catalogMerge';
import { catalogEntryProblems, catalogFeedEntrySchema, catalogFileSchema } from '../src/shared/schemas';

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
    // Seen in the first live run: distributor displays, TCGplayer-made sets, club-store exclusives.
    for (const name of [
      'Delta Reign Booster Pack Art Bundle [Set of 4]',
      '30th Celebration Mini Tin Display',
      'Ascended Heroes Booster Bundle Display',
      'Costco Ascended Heroes Mini Tins 5-Pack',
      'Fusion Strike Elite Trainer Box & 6 Bonus Cards (Sam\'s Club)',
      'Prismatic Evolutions Sleeved Booster Display',
      'V Battle Deck Display [Venusaur V/Blastoise V]',
      'Trainer Battle Deck - Misty of Cerulean City Gym (JP Pokemon Center Exclusive)',
    ]) {
      expect(isSealed({ ...etb, name })).toBe(false);
    }
    for (const name of ['Surging Sparks Booster Display Box', 'Prismatic Evolutions Booster Bundle', 'Destined Rivals 3 Pack Blister [Kangaskhan]']) {
      expect(isSealed({ ...etb, name })).toBe(true);
    }
  });

  it('takes regular sets, and products in no set only when they are new', () => {
    const g = (name: string) => ({ groupId: 1, name, publishedOn: '2026-01-01' });
    expect(isSetGroup(g('SV08: Surging Sparks'))).toBe(true);
    expect(isSetGroup(g('ME: 30th Celebration'))).toBe(true);
    expect(isSetGroup(g('SV: Prismatic Evolutions'))).toBe(true);
    expect(isSetGroup(g('SV: Scarlet & Violet Promo Cards'))).toBe(false);
    expect(isSetGroup(g('EX Trainer Kit 1: Latias & Latios'))).toBe(false);
    expect(isSetGroup(g('POP Series 5'))).toBe(false);
    expect(isSetGroup(g('Miscellaneous Cards & Products'))).toBe(false);
    expect(isMiscGroup(g('Miscellaneous Cards & Products'))).toBe(true);
    const ids = Array.from({ length: 100 }, (_, i) => 600_000 + i * 1000);
    expect(recentIdThreshold([1, ...ids])).toBe(604_000);
    expect(recentIdThreshold([])).toBe(Number.POSITIVE_INFINITY);
  });

  it('knows product types and their usual retail price', () => {
    expect(classify('30th Celebration Pokemon Center Elite Trainer Box', msrp)).toEqual({ category: 'Pokémon Center Exclusive', msrp: 59.99 });
    expect(classify('Surging Sparks Booster Bundle', msrp)).toEqual({ category: 'Booster Bundle', msrp: 26.94 });
    expect(classify('Surging Sparks Booster Box', msrp).msrp).toBe(161.64);
    expect(classify('Mini Tin [Pikachu]', msrp).category).toBe('Tin');
    expect(classify('Ditto Premium Collection', msrp)).toEqual({ category: 'Collection Box', msrp: null });
    // Seen in the first live run: the item type must be what the product is, not what it contains.
    expect(classify('Delta Reign Pokemon Center Elite Trainer Box (Exclusive)', msrp).msrp).toBe(59.99);
    expect(classify('30th Celebration Mini Tin [Moltres]', msrp)).toEqual({ category: 'Tin', msrp: 9.99 });
    expect(classify('Destined Rivals 3 Pack Blister [Kangaskhan]', msrp).msrp).toBe(14.99);
    expect(classify('Pokemon TCG: Twin Mini Portfolio & Booster Packs [Mega Mewtwo & Guzzlord]', msrp)).toEqual({ category: 'Collection Box', msrp: null });
    expect(classify("2 Booster Packs & Latios Collector's Pin", msrp)).toEqual({ category: 'Collection Box', msrp: null });
    expect(classify('Premium Poster Collection: Mega Lucario', msrp).msrp).toBeNull();
    expect(classify('League Battle Deck [Mega Greninja ex]', msrp).msrp).toBe(29.99);
  });

  it('builds an entry with margin, links, release date and price changes', () => {
    const history: PriceHistory = { version: 1, prices: { '704143': { '2026-09-26': 140, '2026-09-03': 100 } } };
    const entry = buildEntry({ product: etb, group, prices: [{ productId: 704143, lowPrice: 149, midPrice: 160, marketPrice: 154, subTypeName: 'Normal' }], msrp, links, history, today: '2026-10-03' });
    expect(entry).toMatchObject({ id: 'tcg-704143', category: 'Elite Trainer Box', set: '30th Celebration', msrp: 49.99, msrpEstimated: false, releaseDate: '2026-09-16' });
    expect(entry.market).toMatchObject({ price: 154, low: 149, change7d: 0.1, change30d: 0.54 });
    expect(entry.retailers.target.url).toContain('A-1010892076');
    expect(entry.retailers.bestbuy.url).toContain('13089535');
    expect(entry.score).toBeCloseTo(Math.log2(154 / 49.99) + Math.log2(1 + (154 - 49.99) / 25) + 0.2, 2);
    // The entry must be valid for the app, links included.
    expect(catalogFeedEntrySchema.safeParse(entry).success).toBe(true);
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

  it('ranks dollar profit as well as percentage', () => {
    const etbScore = scoreOf(155, 49.99, null, false); // +$105, +210%
    const tinScore = scoreOf(45, 9.99, null, false); // +$35, +350%
    const pcEtbScore = scoreOf(531, 59.99, null, false);
    expect(pcEtbScore).toBeGreaterThan(etbScore);
    expect(etbScore).toBeGreaterThan(tinScore);
    expect(scoreOf(null, 49.99, 0.2, true)).toBeCloseTo(0.65, 3);
    expect(scoreOf(40, 49.99, null, false)).toBeLessThan(0);
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
