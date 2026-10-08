import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  analyzeDrop,
  askClaude,
  catalogCandidates,
  DropReaderError,
  extractUrls,
  isPublicWebUrl,
  resolveLink,
  toProposals,
  type ClaudeLike,
  type DropOutput,
  type FetchLike,
} from '../src/main/drops';
import { catalogEntrySchema } from '../src/shared/schemas';

const NOW = Date.parse('2026-10-08T03:40:00-07:00');
const TOMORROW_9_PDT = Date.parse('2026-10-09T09:00:00-07:00');

const WALMART_POST =
  'Pokemon 30th Celebration Booster Bundle two pack, Prismatic Evolutions Premium Figure Collection and more will be available at Walmart via draw entry tomorrow at 9 AM PDT View draw page: https://howl.link/ulo7he9hwm3fd 🔔 We\'ll update and notify when entries go live. #Pokemon #PokemonTCG #ad';

const catalog = [
  catalogEntrySchema.parse({
    id: 'tcg-1',
    name: '30th Celebration Booster Bundle 2-Pack',
    set: 'ME: 30th Celebration',
    category: 'Booster Bundle',
    msrp: 53.98,
    retailers: {
      target: { url: 'https://www.target.com/p/-/A-1010892076', sku: '' },
      bestbuy: { url: '', sku: '' },
      amazon: { url: '', sku: '' },
      pokemoncenter: { url: '', sku: '' },
    },
  }),
  catalogEntrySchema.parse({ id: 'tcg-2', name: 'Prismatic Evolutions Premium Figure Collection', set: 'SV: Prismatic Evolutions', category: 'Collection Box', msrp: 79.99 }),
  catalogEntrySchema.parse({ id: 'tcg-3', name: 'Surging Sparks Elite Trainer Box', set: 'SV: Surging Sparks', category: 'Elite Trainer Box', msrp: 49.99 }),
];

function drop(overrides: Partial<DropOutput['drops'][number]> = {}): DropOutput['drops'][number] {
  return {
    product_name: '30th Celebration Booster Bundle two pack',
    catalog_id: 'tcg-1',
    store_name: 'Walmart',
    store: 'other',
    sale_type: 'draw_or_raffle',
    starts_at: '2026-10-09T09:00:00-07:00',
    time_text: 'tomorrow at 9 AM PDT',
    product_url: '',
    price: 0,
    notes: '',
    ...overrides,
  };
}

function message(output: unknown, overrides: Partial<Anthropic.Beta.BetaMessage> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(output), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 400 },
    ...overrides,
  } as unknown as Anthropic.Beta.BetaMessage;
}

function fakeClient(response: Anthropic.Beta.BetaMessage | Error) {
  const create = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: { beta: { messages: { create } } } as unknown as ClaudeLike, create };
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('drop links', () => {
  it('pulls links out of a post without trailing punctuation', () => {
    expect(extractUrls('Draw: https://howl.link/abc). Also https://www.target.com/p/-/A-1, and https://howl.link/abc')).toEqual([
      'https://howl.link/abc',
      'https://www.target.com/p/-/A-1',
    ]);
  });

  it('only opens public web hosts', () => {
    expect(isPublicWebUrl('https://howl.link/x')).toBe(true);
    expect(isPublicWebUrl('http://localhost:3000/x')).toBe(false);
    expect(isPublicWebUrl('http://192.168.1.1/')).toBe(false);
    expect(isPublicWebUrl('file:///C:/x')).toBe(false);
  });

  it('follows redirects and a meta refresh, then reads the page', async () => {
    const pages: Record<string, () => Response> = {
      'https://howl.link/ulo7he9hwm3fd': () => new Response(null, { status: 301, headers: { location: 'https://go.example.com/r/1' } }),
      'https://go.example.com/r/1': () => htmlResponse('<meta http-equiv="refresh" content="0;url=https://www.walmart.com/cp/pokemon-draw/123">'),
      'https://www.walmart.com/cp/pokemon-draw/123': () =>
        htmlResponse(
          '<html><head><title>Pokémon draw | Walmart</title><meta property="og:description" content="Enter for a chance to buy"></head><body><script>x()</script><h1>Enter the draw</h1><a href="https://www.walmart.com/ip/Pokemon-30th-Bundle/5551234">Bundle</a></body></html>',
        ),
    };
    const fetchFn: FetchLike = vi.fn(async (url: string) => pages[url]!());
    const link = await resolveLink('https://howl.link/ulo7he9hwm3fd', fetchFn);
    expect(link.finalUrl).toBe('https://www.walmart.com/cp/pokemon-draw/123');
    expect(link.title).toBe('Pokémon draw | Walmart');
    expect(link.description).toBe('Enter for a chance to buy');
    expect(link.text).toContain('Enter the draw');
    expect(link.text).not.toContain('x()');
    expect(link.storeLinks).toEqual(['https://www.walmart.com/ip/Pokemon-30th-Bundle/5551234']);
  });

  it('does not visit store product links or private hosts', async () => {
    const fetchFn = vi.fn() as unknown as FetchLike;
    expect((await resolveLink('https://www.target.com/p/-/A-1010892076', fetchFn)).finalUrl).toContain('A-1010892076');
    const redirectToLan: FetchLike = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } }));
    expect((await resolveLink('https://short.example/x', redirectToLan)).error).toMatch(/will not open/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('catalog candidates', () => {
  it('ranks entries that share words with the post', () => {
    const ids = catalogCandidates(WALMART_POST, catalog).map((e) => e.id);
    expect(ids).toContain('tcg-1');
    expect(ids).toContain('tcg-2');
    expect(ids).not.toContain('tcg-3');
  });
});

describe('asking Claude', () => {
  it('uses the drop model with structured output and default fallbacks', async () => {
    const { client, create } = fakeClient(message({ summary: 's', drops: [drop()], warnings: [] }));
    const result = await askClaude(client, 'post');
    expect(result.output.drops).toHaveLength(1);
    const params = (create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params).not.toHaveProperty('thinking');
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('reports refusals, truncation and bad answers plainly', async () => {
    await expect(askClaude(fakeClient(message({}, { stop_reason: 'refusal', content: [] })).client, 'p')).rejects.toThrow(/declined/);
    await expect(askClaude(fakeClient(message({}, { stop_reason: 'max_tokens' })).client, 'p')).rejects.toThrow(/shorter/);
    await expect(askClaude(fakeClient(message({ summary: 'only' })).client, 'p')).rejects.toBeInstanceOf(DropReaderError);
  });
});

describe('proposals', () => {
  it('flags a Walmart draw and offers the catalog’s Target link instead', () => {
    const [proposal] = toProposals({ summary: '', drops: [drop()], warnings: [] }, WALMART_POST, [], catalog, NOW);
    expect(proposal!.retailer).toBeNull();
    expect(proposal!.blocker).toMatch(/Walmart isn’t supported/);
    expect(proposal!.startsAt).toBe(TOMORROW_9_PDT);
    expect(proposal!.msrp).toBe(53.98);
    expect(proposal!.alternatives).toEqual([{ retailer: 'target', url: 'https://www.target.com/p/-/A-1010892076' }]);
  });

  it('keeps a product link from the post and drops one Claude made up', () => {
    const post = 'Surging Sparks ETB at Target 9am PT tomorrow https://www.target.com/p/surging-sparks/-/A-91619922';
    const output: DropOutput = {
      summary: '',
      warnings: [],
      drops: [
        drop({ store: 'target', store_name: 'Target', sale_type: 'online_sale', catalog_id: '', product_url: 'https://www.target.com/p/surging-sparks/-/A-91619922' }),
        drop({ store: 'bestbuy', store_name: 'Best Buy', sale_type: 'online_sale', catalog_id: '', product_url: 'https://www.bestbuy.com/site/x/6599999.p?skuId=6599999' }),
      ],
    };
    const [target, bestbuy] = toProposals(output, post, [], catalog, NOW);
    expect(target!.blocker).toBeNull();
    expect(target!.url).toBe('https://www.target.com/p/surging-sparks/-/A-91619922');
    expect(bestbuy!.url).toBe('');
    expect(bestbuy!.notes).toMatch(/not in the post/);
  });

  it('does not schedule times that passed or have no offset', () => {
    const output: DropOutput = {
      summary: '',
      warnings: [],
      drops: [
        drop({ store: 'target', sale_type: 'online_sale', starts_at: '2026-10-07T09:00:00-07:00' }),
        drop({ store: 'target', sale_type: 'online_sale', starts_at: '2026-10-09T09:00:00' }),
      ],
    };
    const [past, local] = toProposals(output, '', [], catalog, NOW);
    expect(past!.startsAt).toBeNull();
    expect(past!.notes).toMatch(/passed/);
    expect(local!.startsAt).toBeNull();
  });

  it('reads the Walmart example end to end', async () => {
    const fetchFn: FetchLike = vi.fn(async () => htmlResponse('<title>Walmart draw</title>'));
    const { client, create } = fakeClient(
      message({ summary: 'Walmart draw tomorrow 9 AM PDT', drops: [drop(), drop({ product_name: 'Prismatic Evolutions Premium Figure Collection', catalog_id: 'tcg-2' })], warnings: ['Sponsored post (#ad)'] }),
    );
    const analysis = await analyzeDrop(WALMART_POST, { client, fetch: fetchFn, catalog, now: NOW, timeZone: 'America/Los_Angeles' });
    expect(analysis.drops.map((d) => d.blocker !== null)).toEqual([true, true]);
    expect(analysis.warnings).toEqual(['Sponsored post (#ad)']);
    expect(analysis.model).toBe('claude-opus-5-5');
    const sent = ((create.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(sent).toContain('Current time: 2026-10-08T');
    expect(sent).toContain('https://howl.link/ulo7he9hwm3fd');
    expect(sent).toContain('title: Walmart draw');
    expect(sent).toContain('tcg-1 | 30th Celebration Booster Bundle 2-Pack');
  });
});
