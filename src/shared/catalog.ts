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

/** A product counts as hot when it resells for at least 50% over retail, or its price jumped 15%+ in a week. */
export function isHot(entry: CatalogEntry): boolean {
  const margin = catalogMargin(entry);
  return (margin !== null && margin.pct >= 0.5) || (entry.market?.change7d ?? 0) >= 0.15;
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
