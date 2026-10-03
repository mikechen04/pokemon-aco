// Pure building blocks of the catalog feed: no network, no files, so they are unit tested.
// The feed is built from TCGplayer's catalog and prices as published daily by tcgcsv.com.
import type { CatalogFeed, CatalogMarket, RetailerId } from '../../src/shared/types';

export type FeedEntry = CatalogFeed['entries'][number];

export interface TcgGroup {
  groupId: number;
  name: string;
  abbreviation?: string;
  publishedOn: string;
}

export interface TcgProduct {
  productId: number;
  name: string;
  imageUrl?: string;
  groupId: number;
  url?: string;
  extendedData?: Array<{ name: string; value?: string }>;
  presaleInfo?: { isPresale?: boolean; releasedOn?: string | null } | null;
}

export interface TcgPrice {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  marketPrice: number | null;
  subTypeName?: string | null;
}

/** catalog/sources/msrp.json */
export interface MsrpSource {
  /** Confirmed retail prices by TCGplayer product id. */
  known: Record<string, number>;
  /**
   * Product types, first match wins: regex source matched against the product name. With `end`,
   * the name must end with it (bracketed notes aside), so a bundle containing the item does not match.
   */
  types: Array<{ match: string; end?: boolean; category: string; msrp: number | null }>;
}

/** One line of catalog/sources/links.json: store links checked by hand. */
export interface CuratedLink {
  tcgplayerId?: number;
  /** Alternative to the id: every one of these must appear in the product name. */
  nameIncludes?: string[];
  nameExcludes?: string[];
  target?: string;
  bestbuy?: string;
  amazon?: string;
  pokemoncenter?: string;
}

/** catalog/history.json: market price per product per day, for 7- and 30-day changes. */
export interface PriceHistory {
  version: 1;
  prices: Record<string, Record<string, number>>;
}

export const RETAILERS: RetailerId[] = ['target', 'bestbuy', 'amazon', 'pokemoncenter'];

/** TCGCSV answers `{ success, errors, results }`; accept a bare array too. */
export function resultsOf<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const results = (body as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as T[]) : [];
}

const CARD_FIELDS = new Set(['number', 'rarity', 'cardtype', 'hp', 'stage']);
/** Not a single retail item: cases and displays for distributors, code cards, TCGplayer-made sets of packs. */
const NOT_RETAIL =
  /\bcode cards?\b|\bcase\b|\bdigital\b|\bjumbo\b|\bsingle card\b|\bart card\b|\b(?:bundles?|tins?|blisters?|collections?|sleeved boosters?|packs?|boxes|decks?) display\b|\bart bundle\b|\bset of \d+\b|\bbundle of\b|\blot\b|\d+[- ]pack (?:of )?mini tins?|mini tins? \(?\d+[- ]pack|\bjp\b|japanese/i;
/** Exclusives of stores this app does not shop at. */
const OTHER_STORES = /\bcostco\b|\bsam'?s club\b|\bbj'?s\b|\bwalmart\b|\bgamestop\b|\bmeijer\b|\bkroger\b|\bdollar general\b|\bfive below\b|\bwalgreens\b|\bcvs\b/i;

/** Sealed product (not a single card), sold one at a time at the stores this app supports. */
export function isSealed(product: TcgProduct): boolean {
  if ((product.extendedData ?? []).some((d) => CARD_FIELDS.has(d.name.toLowerCase().replace(/[\s_]+/g, '')))) return false;
  return !NOT_RETAIL.test(product.name) && !OTHER_STORES.test(product.name);
}

/** A regular expansion's group ("SV08: Surging Sparks", "ME: 30th Celebration"), not promos or kits. */
export function isSetGroup(group: TcgGroup): boolean {
  return /^[A-Z]{1,4}\d{0,3}[a-z]?:\s/.test(group.name) && !/promo|energ(?:y|ies)|trainer kit|jumbo/i.test(group.name);
}

/** "Miscellaneous Cards & Products": collections, tins and boxes that belong to no set. */
export function isMiscGroup(group: TcgGroup): boolean {
  return /miscellaneous/i.test(group.name);
}

/**
 * TCGplayer product ids grow over time. Products in no set count as recent when their id is at
 * least the low end (5th percentile) of the ids in recent sets.
 */
export function recentIdThreshold(ids: number[]): number {
  if (ids.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...ids].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.05)] ?? sorted[0]!;
}

/** Trailing notes such as "[Pikachu]" or "(Exclusive)". */
const TRAILING_NOTES = String.raw`(?:\s*(?:\[[^\]]*\]|\([^)]*\)))*\s*$`;

export function classify(name: string, source: MsrpSource): { category: string; msrp: number | null } {
  for (const type of source.types) {
    const pattern = type.end ? `(?:${type.match})${TRAILING_NOTES}` : type.match;
    if (new RegExp(pattern, 'i').test(name)) return { category: type.category, msrp: type.msrp };
  }
  return { category: 'Other', msrp: null };
}

/** "SV08: Surging Sparks" -> "Surging Sparks", "ME: 30th Celebration" -> "30th Celebration". */
export function cleanSetName(groupName: string): string {
  return groupName.replace(/^[A-Z0-9&]{1,8}:\s*/i, '').trim();
}

export function dayOf(iso: string | null | undefined): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '');
  return match?.[1] ?? '';
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The price a product resells for: recent sales, else the median listing (new and presale items). */
export function marketPriceOf(prices: TcgPrice[]): { price: number | null; low: number | null } {
  const row = prices.find((p) => p.marketPrice != null) ?? prices.find((p) => p.midPrice != null) ?? prices[0];
  if (!row) return { price: null, low: null };
  return { price: row.marketPrice ?? row.midPrice ?? null, low: row.lowPrice ?? null };
}

export function recordPrice(history: PriceHistory, productId: number, day: string, price: number): void {
  const key = String(productId);
  (history.prices[key] ??= {})[day] = Math.round(price * 100) / 100;
}

/** Relative change against the price recorded `days` ago (closest day within ±2). */
export function changeSince(history: PriceHistory, productId: number, today: string, days: number): number | null {
  const series = history.prices[String(productId)];
  const now = series?.[today];
  if (!series || now == null) return null;
  for (const offset of [0, -1, 1, -2, 2]) {
    const then = series[addDays(today, -days + offset)];
    if (then != null && then > 0) return Math.round(((now - then) / then) * 1000) / 1000;
  }
  return null;
}

export function pruneHistory(history: PriceHistory, today: string, keepDays = 40): void {
  const oldest = addDays(today, -keepDays);
  for (const [id, series] of Object.entries(history.prices)) {
    for (const day of Object.keys(series)) if (day < oldest) delete series[day];
    if (Object.keys(series).length === 0) delete history.prices[id];
  }
}

/**
 * Ranking for "Hottest": the resale margin as a percentage and in dollars, each on a log scale
 * (doubling the money counts 1; $25 of profit counts 1, $75 counts 2), so cheap hyped items and
 * pricey ones both rank and a thinly traded outlier cannot swamp the list. Plus twice the weekly
 * price change, plus a little for products not out yet. Unknown parts count as zero.
 */
export function scoreOf(price: number | null, msrp: number | null, change7d: number | null, upcoming: boolean): number {
  let margin = 0;
  if (price !== null && msrp) {
    const pct = (price - msrp) / msrp;
    margin = Math.log2(1 + Math.max(-0.99, pct)) + Math.log2(1 + Math.max(0, price - msrp) / 25);
  }
  const momentum = change7d === null ? 0 : Math.max(-0.5, Math.min(change7d, 2));
  return Math.round((margin + 2 * momentum + (upcoming ? 0.25 : 0)) * 1000) / 1000;
}

function emptyRetailers(): FeedEntry['retailers'] {
  return { target: { url: '', sku: '' }, bestbuy: { url: '', sku: '' }, amazon: { url: '', sku: '' }, pokemoncenter: { url: '', sku: '' } };
}

export function normalizeWords(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function curatedLinksFor(product: TcgProduct, links: CuratedLink[]): Partial<Record<RetailerId, string>> {
  const name = normalizeWords(product.name);
  const has = (word: string) => ` ${name} `.includes(` ${normalizeWords(word)} `);
  const out: Partial<Record<RetailerId, string>> = {};
  for (const link of links) {
    const byId = link.tcgplayerId === product.productId;
    const byName =
      link.tcgplayerId === undefined &&
      (link.nameIncludes?.length ?? 0) > 0 &&
      (link.nameIncludes ?? []).every(has) &&
      !(link.nameExcludes ?? []).some(has);
    if (!byId && !byName) continue;
    for (const id of RETAILERS) if (link[id] && !out[id]) out[id] = link[id];
  }
  return out;
}

const STOP_WORDS = new Set(['pokemon', 'tcg', 'trading', 'card', 'cards', 'game', 'the', 'a', 'an', 'of', 'and', 'with', 'me', 'sv', 'swsh', 'scarlet', 'violet', 'mega', 'evolution', 'sword', 'shield']);

/** Words of a TCGplayer product name that a store's title for the same product must contain. */
export function requiredWords(productName: string, setName: string): string[] {
  const words = normalizeWords(productName).split(' ').filter((w) => w && !STOP_WORDS.has(w));
  const setWords = normalizeWords(setName).split(' ').filter((w) => w && !STOP_WORDS.has(w));
  // Some sealed products are named without their set ("Elite Trainer Box"): add the set's words.
  return [...new Set(setWords.some((w) => words.includes(w)) ? words : [...setWords, ...words])];
}

export interface StoreHit {
  id: string;
  title: string;
  url: string;
  price?: number;
}

/**
 * The store listing that is clearly this product: it has every required word, is not a
 * Pokémon Center item or a case when the product is not, and costs a believable amount.
 * Of several matches the one with the fewest extra words wins; a tie is ambiguous (null).
 */
export function bestStoreMatch(productName: string, setName: string, msrp: number | null, hits: StoreHit[]): StoreHit | null {
  const required = requiredWords(productName, setName);
  if (required.length < 2) return null;
  const productNorm = ` ${normalizeWords(productName)} `;
  const scored: Array<{ hit: StoreHit; extra: number }> = [];
  for (const hit of hits) {
    const title = ` ${normalizeWords(hit.title)} `;
    if (!required.every((w) => title.includes(` ${w} `))) continue;
    if (title.includes(' pokemon center ') && !productNorm.includes(' pokemon center ')) continue;
    if (/ (case|display case|lot|bundle of|set of) /.test(title) && !/ (case|lot) /.test(productNorm)) continue;
    if (msrp && hit.price !== undefined && (hit.price < msrp * 0.5 || hit.price > msrp * 2)) continue;
    const extra = title.trim().split(' ').filter((w) => !STOP_WORDS.has(w) && !required.includes(w)).length;
    scored.push({ hit, extra });
  }
  scored.sort((a, b) => a.extra - b.extra);
  const [first, second] = scored;
  if (!first || (second && second.extra === first.extra && second.hit.id !== first.hit.id)) return null;
  return first.hit;
}

export interface BuildInput {
  product: TcgProduct;
  group: TcgGroup;
  prices: TcgPrice[];
  msrp: MsrpSource;
  links: CuratedLink[];
  history: PriceHistory;
  today: string;
}

export function buildEntry({ product, group, prices, msrp, links, history, today }: BuildInput): FeedEntry {
  const type = classify(product.name, msrp);
  const knownMsrp = msrp.known[String(product.productId)];
  const retail = knownMsrp ?? type.msrp;
  const { price, low } = marketPriceOf(prices);
  if (price !== null) recordPrice(history, product.productId, today, price);
  const releaseDate = dayOf(product.presaleInfo?.releasedOn) || dayOf(group.publishedOn);
  const upcoming = releaseDate > today;
  const change7d = changeSince(history, product.productId, today, 7);
  const change30d = changeSince(history, product.productId, today, 30);
  const market: CatalogMarket | null = price === null && low === null ? null : { price, low, change7d, change30d, updatedAt: today };
  const retailers = emptyRetailers();
  for (const [id, url] of Object.entries(curatedLinksFor(product, links)) as Array<[RetailerId, string]>) retailers[id] = { url, sku: '' };
  const tcgplayerUrl = /^https:\/\/(?:www\.)?tcgplayer\.com\//i.test(product.url ?? '') ? product.url! : `https://www.tcgplayer.com/product/${product.productId}`;
  return {
    id: `tcg-${product.productId}`,
    name: product.name.trim().slice(0, 160),
    category: type.category,
    set: cleanSetName(group.name).slice(0, 80),
    tags: [],
    imageUrl: /^https:\/\//i.test(product.imageUrl ?? '') ? product.imageUrl! : '',
    msrp: retail ?? null,
    msrpEstimated: knownMsrp === undefined && retail !== null,
    notes: '',
    releaseDate,
    tcgplayerId: product.productId,
    tcgplayerUrl,
    market,
    score: price === null && !upcoming ? null : scoreOf(price, retail ?? null, change7d, upcoming),
    retailers,
  };
}

function hasLinks(entry: FeedEntry): boolean {
  return RETAILERS.some((id) => entry.retailers[id].url || entry.retailers[id].sku);
}

/**
 * Up to `max` entries: products with store links or not released yet first (they are what a
 * task can use), then the highest scores. Products with neither prices nor a future release
 * date are left out.
 */
export function selectEntries(entries: FeedEntry[], today: string, max: number): FeedEntry[] {
  const byScore = (a: FeedEntry, b: FeedEntry) => (b.score ?? -1e9) - (a.score ?? -1e9) || a.name.localeCompare(b.name);
  const useful = entries.filter((e) => e.market !== null || e.releaseDate > today);
  const pinned = useful.filter((e) => hasLinks(e) || e.releaseDate > today).sort(byScore);
  const pinnedIds = new Set(pinned.map((e) => e.id));
  const rest = useful.filter((e) => !pinnedIds.has(e.id)).sort(byScore);
  return [...pinned, ...rest].slice(0, max).sort(byScore);
}
