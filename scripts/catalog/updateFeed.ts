// Builds catalog/feed.json, the product list the app syncs its Catalog tab from.
//
//   Products + prices: TCGplayer's Pokémon catalog as published daily by tcgcsv.com
//                      (sealed products of sets released in the last two years, and upcoming ones).
//   Retail prices:     catalog/sources/msrp.json (confirmed prices, else the usual price per product type).
//   Store links:       catalog/sources/links.json (checked by hand), plus Best Buy's official API
//                      when the BESTBUY_API_KEY secret is set, plus Target's product search (best effort).
//   7/30-day changes:  catalog/history.json, one market price per product per day.
//
// Run with `npm run catalog:feed` (GitHub Actions runs it daily; see .github/workflows/catalog-feed.yml).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bestStoreMatch,
  buildEntry,
  isSealed,
  requiredWords,
  pruneHistory,
  resultsOf,
  selectEntries,
  type CuratedLink,
  type FeedEntry,
  type MsrpSource,
  type PriceHistory,
  type StoreHit,
  type TcgGroup,
  type TcgPrice,
  type TcgProduct,
} from './feedLib';

const ROOT = process.cwd();
const CATALOG = join(ROOT, 'catalog');
const TCGCSV = 'https://tcgcsv.com/tcgplayer';
const POKEMON = 3;
const MAX_ENTRIES = 250;
const RECENT_DAYS = 730;
/** Store searches per run, so a run stays polite and quick. */
const MAX_STORE_SEARCHES = 60;
const USER_AGENT = 'pokemon-aco-catalog-feed/1.0 (+https://github.com/mikechen04/pokemon-aco)';
const TARGET_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string, headers: Record<string, string> = {}, tries = 3): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url.replace(/apiKey=[^&]+/, 'apiKey=***')}: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(2000 * attempt);
    }
  }
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

/** Best Buy's official Products API (free key from developer.bestbuy.com). */
async function searchBestBuy(apiKey: string, words: string[]): Promise<StoreHit[]> {
  const terms = ['pokemon', ...words].map((w) => `search=${encodeURIComponent(w)}`).join('&');
  const url = `https://api.bestbuy.com/v1/products((${terms}))?apiKey=${encodeURIComponent(apiKey)}&show=sku,name,regularPrice,salePrice&pageSize=20&format=json`;
  const body = (await getJson(url)) as { products?: Array<{ sku?: number; name?: string; regularPrice?: number; salePrice?: number }> } | null;
  return (body?.products ?? []).flatMap((p) =>
    p.sku && p.name
      ? [{ id: String(p.sku), title: p.name, url: `https://www.bestbuy.com/site/${p.sku}.p?skuId=${p.sku}`, ...((p.regularPrice ?? p.salePrice) !== undefined ? { price: p.regularPrice ?? p.salePrice } : {}) }]
      : [],
  );
}

/** Target's product search, the one target.com uses. Often refused from cloud servers; that is fine. */
async function searchTarget(words: string[]): Promise<StoreHit[]> {
  const keyword = `pokemon ${words.join(' ')}`;
  const params = new URLSearchParams({ key: TARGET_KEY, channel: 'WEB', count: '24', default_purchasability_filter: 'false', keyword, offset: '0', page: `/s/${keyword}`, platform: 'desktop' });
  const body = await getJson(`https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?${params}`, { origin: 'https://www.target.com', referer: 'https://www.target.com/' }, 1);
  const products = ((body as { data?: { search?: { products?: unknown[] } } } | null)?.data?.search?.products ?? []) as Array<{
    tcin?: string;
    item?: { product_description?: { title?: string } };
    price?: { reg_retail?: number; current_retail?: number };
  }>;
  return products.flatMap((p) => {
    const title = p.item?.product_description?.title?.replace(/&#\d+;/g, (m) => String.fromCharCode(Number(m.slice(2, -1))));
    if (!p.tcin || !title) return [];
    const price = p.price?.reg_retail ?? p.price?.current_retail;
    return [{ id: p.tcin, title, url: `https://www.target.com/p/-/A-${p.tcin}`, ...(price !== undefined ? { price } : {}) }];
  });
}

/** Fills missing Best Buy / Target links for the best-ranked entries by searching those stores. */
async function discoverLinks(entries: FeedEntry[], today: string): Promise<void> {
  const apiKey = process.env.BESTBUY_API_KEY?.trim() ?? '';
  let budget = MAX_STORE_SEARCHES;
  let targetUsable = true;
  const candidates = [...entries]
    .filter((e) => !/pokemon center/i.test(e.name) && (e.releaseDate <= today || daysBetween(today, e.releaseDate) <= 45))
    .sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9));
  for (const entry of candidates) {
    if (budget <= 0) break;
    const words = requiredWords(entry.name, entry.set).slice(0, 8);
    const note: string[] = [];
    if (apiKey && !entry.retailers.bestbuy.url) {
      budget--;
      try {
        const hit = bestStoreMatch(entry.name, entry.set, entry.msrp, await searchBestBuy(apiKey, words));
        if (hit) {
          entry.retailers.bestbuy = { url: hit.url, sku: '' };
          note.push('Best Buy');
        }
      } catch (err) {
        console.warn(`Best Buy search failed: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(400);
    }
    if (targetUsable && !entry.retailers.target.url) {
      budget--;
      try {
        const hit = bestStoreMatch(entry.name, entry.set, entry.msrp, await searchTarget(words));
        if (hit) {
          entry.retailers.target = { url: hit.url, sku: '' };
          note.push('Target');
        }
      } catch (err) {
        // One refusal usually means this server is blocked for the whole run.
        targetUsable = false;
        console.warn(`Target search unavailable from here (${err instanceof Error ? err.message : err}); skipping Target links this run`);
      }
      await sleep(1200);
    }
    if (note.length) entry.notes = `${note.join(' and ')} link found by product search; check it once before a drop.`;
  }
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const msrp = readJson<MsrpSource>(join(CATALOG, 'sources', 'msrp.json'), { known: {}, types: [] });
  const links = readJson<{ links: CuratedLink[] }>(join(CATALOG, 'sources', 'links.json'), { links: [] }).links;
  const history = readJson<PriceHistory>(join(CATALOG, 'history.json'), { version: 1, prices: {} });

  const groups = resultsOf<TcgGroup>(await getJson(`${TCGCSV}/${POKEMON}/groups`));
  if (groups.length === 0) throw new Error('tcgcsv.com returned no Pokémon groups');
  const recent = groups.filter((g) => {
    const published = g.publishedOn?.slice(0, 10) ?? '';
    return published !== '' && daysBetween(published, today) <= RECENT_DAYS;
  });
  console.log(`${groups.length} Pokémon groups on TCGplayer, ${recent.length} released in the last ${RECENT_DAYS} days or upcoming`);

  const entries: FeedEntry[] = [];
  for (const group of recent) {
    const [productsBody, pricesBody] = [await getJson(`${TCGCSV}/${POKEMON}/${group.groupId}/products`), await getJson(`${TCGCSV}/${POKEMON}/${group.groupId}/prices`)];
    const prices = resultsOf<TcgPrice>(pricesBody);
    const pricesById = new Map<number, TcgPrice[]>();
    for (const price of prices) pricesById.set(price.productId, [...(pricesById.get(price.productId) ?? []), price]);
    const sealed = resultsOf<TcgProduct>(productsBody).filter(isSealed);
    for (const product of sealed) {
      entries.push(buildEntry({ product, group, prices: pricesById.get(product.productId) ?? [], msrp, links, history, today }));
    }
    console.log(`  ${group.name}: ${sealed.length} sealed products`);
    await sleep(250);
  }
  if (entries.length === 0) throw new Error('No sealed products found; not replacing the feed');

  const selected = selectEntries(entries, today, MAX_ENTRIES);
  await discoverLinks(selected, today);
  pruneHistory(history, today);

  const feed = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    source: 'TCGplayer prices via tcgcsv.com',
    entries: selected,
  };
  writeJson(join(CATALOG, 'feed.json'), feed);
  writeJson(join(CATALOG, 'history.json'), history);

  const linked = selected.filter((e) => Object.values(e.retailers).some((r) => r.url || r.sku)).length;
  console.log(`\nWrote ${selected.length} entries (${linked} with store links) from ${entries.length} sealed products.`);
  console.log('Top 15 by score:');
  for (const e of selected.slice(0, 15)) {
    const margin = e.market?.price != null && e.msrp ? `${(((e.market.price - e.msrp) / e.msrp) * 100).toFixed(0)}%` : '—';
    console.log(`  ${String(e.score ?? '—').padStart(6)}  $${String(e.market?.price ?? '—').padStart(7)}  msrp ${e.msrpEstimated ? '≈' : ' '}$${e.msrp ?? '—'}  margin ${margin.padStart(5)}  ${e.name}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
