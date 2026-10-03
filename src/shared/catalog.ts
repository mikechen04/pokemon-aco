// Catalog helpers shared by the UI and the main process.
import { RETAILER_IDS, type CatalogEntry } from './types';

export interface Margin {
  /** Market price minus MSRP, USD. */
  amount: number;
  /** As a fraction of MSRP (1.5 = +150%). */
  pct: number;
}

/** Resale margin: TCGplayer market price against retail (MSRP). Null when either is unknown. */
export function catalogMargin(entry: Pick<CatalogEntry, 'msrp' | 'market'>): Margin | null {
  const market = entry.market?.price;
  if (market == null || entry.msrp == null || entry.msrp <= 0) return null;
  return { amount: market - entry.msrp, pct: (market - entry.msrp) / entry.msrp };
}

export function hasStoreLink(entry: CatalogEntry): boolean {
  return RETAILER_IDS.some((id) => Boolean(entry.retailers[id].url || entry.retailers[id].sku));
}

/** The score that puts an entry in the top 15% of the catalog ("Hot"). */
export function hotThreshold(entries: CatalogEntry[]): number {
  const scores = entries.flatMap((e) => (e.score === null ? [] : [e.score])).sort((a, b) => b - a);
  if (scores.length === 0) return Number.POSITIVE_INFINITY;
  return scores[Math.max(0, Math.ceil(scores.length * 0.15) - 1)]!;
}

/**
 * Hot: in the top 15% of the catalog by score while reselling at least 50% over retail, or a
 * price that rose 15%+ in a week.
 */
export function isHot(entry: CatalogEntry, threshold: number): boolean {
  const margin = catalogMargin(entry);
  const top = entry.score !== null && entry.score >= threshold && margin !== null && margin.pct >= 0.5;
  return top || (entry.market?.change7d ?? 0) >= 0.15;
}

export const CATALOG_SORTS = {
  hot: 'Hottest',
  margin: 'Biggest margin',
  market: 'Market price',
  newest: 'Newest',
  name: 'Name',
} as const;
export type CatalogSort = keyof typeof CATALOG_SORTS;

const desc = (a: number | null | undefined, b: number | null | undefined) => (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY);

export function sortCatalog(entries: CatalogEntry[], sort: CatalogSort): CatalogEntry[] {
  const list = [...entries];
  const byName = (a: CatalogEntry, b: CatalogEntry) => a.name.localeCompare(b.name);
  switch (sort) {
    case 'hot':
      return list.sort((a, b) => desc(a.score, b.score) || desc(catalogMargin(a)?.pct, catalogMargin(b)?.pct) || byName(a, b));
    case 'margin':
      return list.sort((a, b) => desc(catalogMargin(a)?.amount, catalogMargin(b)?.amount) || byName(a, b));
    case 'market':
      return list.sort((a, b) => desc(a.market?.price, b.market?.price) || byName(a, b));
    case 'newest':
      return list.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || byName(a, b));
    case 'name':
      return list.sort(byName);
  }
}

/** "+12%" / "−3%" */
export function formatChange(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%`;
}
