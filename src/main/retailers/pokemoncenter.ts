// Pokémon Center
//   Stock: the product page over HTTP, read from its structured data (JSON-LD / page data).
//   Waiting room: when Pokémon Center puts the site behind its queue, each account's own
//   hidden window joins the line and waits. The page refreshes itself; the app only watches
//   it, never reloads or skips it, and notifies you while the queue is what is blocking.
//   Purchase: add to cart and checkout on pokemoncenter.com in the hidden window, with the
//   saved card picked by its last 4 digits and everything verified before placing the order.
import { searchText, type KeywordQuery } from '../../shared/keywords';
import { parsePrice } from '../../shared/money';
import { parseProductInput } from '../../shared/retailers';
import { NeedsSignInError, OutOfStockError, QueueError, RetailerError } from '../engine/errors';
import { assertHttp, assertPage, browserCheckout, browserSignIn, isSignInPage, waitInWaitingRoom } from './flows';
import { availabilityBuyable, findKey, firstNumber, jsonLdProducts, metaContent, nextData, parseHtml } from './html';
import type {
  CartResult,
  CheckoutResult,
  MonitorContext,
  ProductTarget,
  RetailerModule,
  SearchHit,
  SessionContext,
  StockResult,
  TaskContext,
} from './types';

export const POKEMON_CENTER_DEFAULTS = {
  homeUrl: 'https://www.pokemoncenter.com/',
  signInUrl: 'https://www.pokemoncenter.com/account/login',
  cartUrl: 'https://www.pokemoncenter.com/cart',
  searchUrl: 'https://www.pokemoncenter.com/search/',
  addToCartSelectors: ['button[data-testid="add-to-cart-button"]', 'button[class*="add-to-cart" i]'],
  addToCartText: '^add to (cart|bag)$',
  addedText: 'added to (your )?(cart|bag)|view (cart|bag)',
  quantitySelectors: ['select[name*="quantity" i]', 'select[id*="quantity" i]', 'select[aria-label*="quantity" i]'],
  quantityIncreaseText: '^(\\+|increase( quantity)?|increment( quantity)?)$',
  continueText:
    '^(checkout|check out|continue to checkout|proceed to checkout|continue|continue to (shipping|payment|review)|save (and|&) continue|review (your )?order|next)$',
  placeOrderText: '^(place (your )?order|submit order|complete (your )?order)$',
  confirmationUrlPattern: 'order-?confirmation|confirmation|thank-?you',
  soldOutText: 'sold out|out of stock|notify me|coming soon|currently unavailable',
};

type PokemonCenterConfig = typeof POKEMON_CENTER_DEFAULTS;

/** Availability hints inside the page's own data (Next.js payload). */
function availabilityFromPageData(data: unknown): boolean | undefined {
  for (const value of findKey(data, 'availability')) {
    if (typeof value !== 'string') continue;
    if (/^(AVAILABLE|IN_?STOCK|AVAILABLE_FOR_PRE_?ORDER|PRE_?ORDER)$/i.test(value)) return true;
    if (/^(NOT_?AVAILABLE|OUT_?OF_?STOCK|SOLD_?OUT|UNAVAILABLE)$/i.test(value)) return false;
  }
  for (const key of ['isAvailable', 'inStock', 'available']) {
    const flag = findKey(data, key).find((v) => typeof v === 'boolean');
    if (typeof flag === 'boolean') return flag;
  }
  return undefined;
}

export function createPokemonCenter(cfg: () => PokemonCenterConfig): RetailerModule {
  async function checkStock(ctx: MonitorContext, product: ProductTarget): Promise<StockResult> {
    const c = cfg();
    const res = await ctx.http.get(product.url, { signal: ctx.signal });
    // A waiting room in front of the site surfaces as QueueError; a challenge pauses the task.
    assertHttp(res, 'Pokémon Center stock check');
    if (res.status === 404) throw new RetailerError('Pokémon Center has no page at this URL (HTTP 404)');
    if (res.status >= 400) throw new RetailerError(`Pokémon Center answered HTTP ${res.status}`);
    const root = parseHtml(res.text);
    const ld = jsonLdProducts(root)[0];
    const pageData = nextData(root);
    let buyable = availabilityBuyable(ld?.availability) ?? availabilityFromPageData(pageData);
    if (buyable === undefined) {
      const buttons = root.querySelectorAll('button').map((b) => b.text.replace(/\s+/g, ' ').trim());
      if (buttons.some((t) => new RegExp(c.addToCartText, 'i').test(t))) buyable = true;
      else if (buttons.some((t) => new RegExp(c.soldOutText, 'i').test(t))) buyable = false;
    }
    if (buyable === undefined) throw new RetailerError('Could not read stock from the Pokémon Center page');
    const price = ld?.price ?? firstNumber(findKey(pageData, 'price')) ?? parsePrice(metaContent(root, 'product:price:amount')) ?? undefined;
    const title = ld?.name ?? metaContent(root, 'og:title');
    const image = ld?.image ?? metaContent(root, 'og:image');
    return {
      inStock: buyable,
      detail: ld?.availability ?? (buyable ? 'add to cart shown' : 'sold out'),
      url: product.url,
      ...(price !== undefined ? { price } : {}),
      ...(title ? { title } : {}),
      ...(image ? { imageUrl: image } : {}),
    };
  }

  async function search(ctx: MonitorContext, query: KeywordQuery): Promise<SearchHit[]> {
    const res = await ctx.http.get(`${cfg().searchUrl}${encodeURIComponent(searchText(query))}`, { signal: ctx.signal });
    assertHttp(res, 'Pokémon Center search');
    if (res.status >= 400) throw new RetailerError(`Pokémon Center search answered HTTP ${res.status}`);
    const root = parseHtml(res.text);
    const hits = new Map<string, SearchHit>();
    for (const link of root.querySelectorAll('a[href*="/product/"]')) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const url = new URL(href, 'https://www.pokemoncenter.com').toString();
      const parsed = parseProductInput('pokemoncenter', url);
      if (!parsed.ok || hits.has(parsed.product.productId)) continue;
      const title = link.text.replace(/\s+/g, ' ').trim() || link.getAttribute('aria-label') || link.querySelector('img')?.getAttribute('alt') || '';
      if (!title) continue;
      hits.set(parsed.product.productId, { productId: parsed.product.productId, url: parsed.product.url, title });
    }
    return [...hits.values()];
  }

  async function checkSignedIn(ctx: SessionContext): Promise<boolean | null> {
    const cookies = await ctx.handle.session.cookies.get({ url: 'https://www.pokemoncenter.com' });
    const auth = cookies.find((c) => c.name === 'auth')?.value;
    if (!auth) return null;
    try {
      const data = JSON.parse(decodeURIComponent(auth)) as { role?: unknown; roles?: unknown };
      const roles = [data.role, ...(Array.isArray(data.roles) ? data.roles : [])].map(String);
      if (roles.some((r) => /REGISTERED/i.test(r))) return true;
      if (roles.some((r) => /PUBLIC|GUEST|ANONYMOUS/i.test(r))) return false;
    } catch {
      // not the format we know
    }
    return null;
  }

  async function signIn(ctx: TaskContext): Promise<void> {
    const c = cfg();
    await browserSignIn(ctx, {
      url: c.signInUrl,
      homeUrl: c.homeUrl,
      entryLinkText: '^(sign in|log in|sign in / register|sign in or create account)$',
      emailSelectors: ['input[type="email"]', 'input[name="email"]', '#email', 'input[name="username"]'],
      passwordSelectors: ['input[type="password"]'],
      submitText: '^(sign in|log in|continue)$',
      signedIn: async (page) =>
        /pokemoncenter\.com/i.test(page.url()) && !/login|sign-?in/i.test(page.url()) && !(await page.exists(['input[type="password"]'])),
    });
  }

  async function prepare(ctx: TaskContext): Promise<void> {
    ctx.log('Pokémon Center: add to cart and checkout run in this account’s window; a waiting room is joined when it appears');
  }

  async function waitInQueue(ctx: TaskContext, product: ProductTarget): Promise<void> {
    const page = await ctx.page();
    const rejoin = ctx.memo.get('queue:rejoin') === '1';
    ctx.memo.delete('queue:rejoin');
    const onSite = /pokemoncenter\.com|queue/i.test(page.url());
    if (rejoin || !onSite) await page.goto(product.url, ctx.signal);
    await waitInWaitingRoom(ctx, page, 'Pokémon Center');
  }

  async function addToCart(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const c = cfg();
    const page = await ctx.page();
    if (!page.url().includes(product.productId)) await page.goto(product.url, ctx.signal);
    let snapshot = await assertPage(page, 'Pokémon Center product page');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();

    let quantity = ctx.task.quantity;
    if (quantity > 1 && !(await page.selectValue(c.quantitySelectors, String(quantity)))) {
      let increased = 0;
      for (; increased < quantity - 1; increased++) {
        if (!(await page.click({ text: c.quantityIncreaseText })).clicked) break;
      }
      if (increased < quantity - 1) {
        ctx.log(`Could not set quantity ${quantity} on Pokémon Center; adding ${increased + 1}`, 'warn');
        quantity = increased + 1;
      }
    }
    const clicked = await page.clickWhenReady({ selectors: c.addToCartSelectors, text: c.addToCartText }, { timeoutMs: 12_000, signal: ctx.signal });
    if (!clicked) {
      snapshot = await assertPage(page, 'Pokémon Center product page');
      if (new RegExp(c.soldOutText, 'i').test(snapshot.text)) throw new OutOfStockError();
      throw new RetailerError('Could not find the Pokémon Center add-to-cart button');
    }
    const added = await page.waitFor(
      async () => {
        const d = await page.detect();
        if (d.kind === 'queue') throw new QueueError(d.detail, d.snapshot.url);
        return new RegExp(c.addedText, 'i').test(d.snapshot.text) ? true : null;
      },
      { timeoutMs: 15_000, signal: ctx.signal },
    );
    if (!added) {
      snapshot = await assertPage(page, 'Pokémon Center add to cart');
      if (new RegExp(c.soldOutText, 'i').test(snapshot.text)) throw new OutOfStockError();
      ctx.log('No add-to-cart confirmation shown; checkout will verify the cart', 'warn');
    }
    return { quantity, via: 'browser', detail: 'product page', ...(stock.price !== undefined ? { unitPrice: stock.price } : {}) };
  }

  async function checkout(ctx: TaskContext): Promise<CheckoutResult> {
    const c = cfg();
    const page = await ctx.page();
    return browserCheckout(ctx, page, {
      startUrl: c.cartUrl,
      continueText: c.continueText,
      placeOrderText: c.placeOrderText,
      paymentSectionText: '^payment',
      changePaymentText: '^(change|edit)$',
      confirmPaymentText: '^(use this card|save|continue|done|apply)$',
      confirmationUrl: new RegExp(c.confirmationUrlPattern, 'i'),
      maxSteps: 8,
    });
  }

  return {
    id: 'pokemoncenter',
    // Shared monitoring keeps traffic to one request per product per interval, however many
    // accounts are running; each account joins the waiting room in its own window.
    monitorScope: 'shared',
    get homeUrl() {
      return cfg().homeUrl;
    },
    get signInUrl() {
      return cfg().signInUrl;
    },
    checkStock,
    search,
    checkSignedIn,
    signIn,
    prepare,
    addToCart,
    checkout,
    waitInQueue,
  };
}
