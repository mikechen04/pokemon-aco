// Best Buy
//   Stock + search: the official Best Buy Products API when you add a (free) developer key
//   in Settings; otherwise the button-state and price endpoints bestbuy.com itself uses.
//   Add to cart: the cart API used by bestbuy.com (HTTP). When Best Buy holds the item
//   behind its "Please Wait" add-to-cart queue, the product page is used and the queue is
//   waited out, never skipped.
//   Checkout: bestbuy.com's own fast-track checkout page in the hidden window.
import { searchText, type KeywordQuery } from '../../shared/keywords';
import { parsePrice } from '../../shared/money';
import { BESTBUY_SKU, bestBuySkuFromHtml, canonicalProductUrl } from '../../shared/retailers';
import { NeedsBrowserError, OutOfStockError, PauseError, RetailerError, sleep } from '../engine/errors';
import { looksOutOfStock } from '../engine/guards';
import type { HttpResponse } from '../engine/http';
import { assertHttp, assertPage, browserCheckout, browserSignIn, digNumber, digString, isSignInPage } from './flows';
import { attrOf, findKey, firstNumber, firstString, parseHtml, textOf } from './html';
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

export const BESTBUY_DEFAULTS = {
  officialApiUrl: 'https://api.bestbuy.com/v1/products',
  buttonStateUrl: 'https://www.bestbuy.com/button-state/api/v5/button-state',
  priceBlocksUrl: 'https://www.bestbuy.com/api/3.0/priceBlocks',
  searchPageUrl: 'https://www.bestbuy.com/site/searchpage.jsp',
  addToCartUrl: 'https://www.bestbuy.com/cart/api/v1/addToCart',
  homeUrl: 'https://www.bestbuy.com/',
  signInUrl: 'https://www.bestbuy.com/identity/global/signin',
  signUpUrl: 'https://www.bestbuy.com/identity/newAccount',
  accountUrl: 'https://www.bestbuy.com/site/customer/myaccount',
  checkoutUrl: 'https://www.bestbuy.com/checkout/r/fast-track',
  inStockStates: ['ADD_TO_CART', 'PRE_ORDER'],
  addToCartSelectors: ['button.add-to-cart-button', 'button[data-button-state="ADD_TO_CART"]', 'button[data-button-state="PRE_ORDER"]'],
  addToCartText: '^(add to cart|pre-?order)$',
  waitText: 'please wait',
  addedText: 'added to cart|go to cart|added to your cart',
  placeOrderText: '^place (your )?order$',
  continueText: '^(continue to payment information|continue to schedule|continue to review|continue|checkout)$',
  confirmationUrlPattern: 'thank-?you|order-?confirmation',
  /** Longest wait for Best Buy's add-to-cart queue before giving up the attempt. */
  maxQueueWaitMs: 15 * 60_000,
};

type BestBuyConfig = typeof BESTBUY_DEFAULTS;

function safeJson(res: HttpResponse): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function jsonHeaders(referer: string): Record<string, string> {
  return { accept: 'application/json', origin: 'https://www.bestbuy.com', referer };
}

const OFFICIAL_FIELDS = 'sku,name,salePrice,onlineAvailability,url,image';

export function createBestBuy(cfg: () => BestBuyConfig): RetailerModule {
  /** Product code (from /product/<name>/<CODE> links) -> numeric SKU. */
  const skuByCode = new Map<string, string>();

  /** The product with its numeric SKU. Links that only carry a product code are looked up once. */
  async function withSku(ctx: SessionContext, product: ProductTarget): Promise<ProductTarget> {
    if (BESTBUY_SKU.test(product.productId)) return product;
    let sku = skuByCode.get(product.productId);
    if (!sku) {
      const res = await ctx.http.get(product.url, { signal: ctx.signal, headers: { accept: 'text/html' } });
      assertHttp(res, 'Best Buy product page');
      if (res.status >= 400) throw new RetailerError(`Best Buy product page answered HTTP ${res.status}`);
      const found = bestBuySkuFromHtml(res.text);
      if (!found) throw new RetailerError('Could not find the SKU on this Best Buy product page. Use a link that contains /sku/1234567 or skuId=.');
      skuByCode.set(product.productId, found);
      sku = found;
    }
    return { ...product, productId: sku };
  }

  async function stockFromOfficialApi(ctx: MonitorContext, product: ProductTarget, apiKey: string): Promise<StockResult> {
    const c = cfg();
    const url = `${c.officialApiUrl}/${product.productId}.json?apiKey=${encodeURIComponent(apiKey)}&show=${OFFICIAL_FIELDS}&format=json`;
    const res = await ctx.http.get(url, { signal: ctx.signal, headers: { accept: 'application/json' } });
    assertHttp(res, 'Best Buy API');
    if (res.status === 403) throw new RetailerError('The Best Buy API key was rejected (check it in Settings)');
    if (res.status === 404) throw new RetailerError(`Best Buy does not recognize SKU ${product.productId}`);
    if (res.status >= 400) throw new RetailerError(`Best Buy API answered HTTP ${res.status}`);
    const data = safeJson(res);
    const available = (data as { onlineAvailability?: unknown })?.onlineAvailability === true;
    const price = digNumber(data, 'salePrice');
    const title = digString(data, 'name');
    const image = digString(data, 'image');
    return {
      inStock: available,
      detail: available ? 'onlineAvailability' : 'not available online',
      url: digString(data, 'url') ?? product.url,
      ...(price !== undefined ? { price } : {}),
      ...(title ? { title } : {}),
      ...(image ? { imageUrl: image } : {}),
    };
  }

  async function stockFromSite(ctx: MonitorContext, product: ProductTarget): Promise<StockResult> {
    const c = cfg();
    const sku = product.productId;
    const zip = /^\d{5}$/.test(ctx.zip.slice(0, 5)) ? ctx.zip.slice(0, 5) : '';
    const stateUrl = `${c.buttonStateUrl}?skus=${sku}&conditions=&storeId=&destinationZipCode=${zip}&context=pdp&consolidated=false&source=buttonView&xboxAllAccess=false`;
    const [stateRes, priceRes] = await Promise.all([
      ctx.http.get(stateUrl, { signal: ctx.signal, headers: jsonHeaders(product.url) }),
      ctx.http.get(`${c.priceBlocksUrl}?skus=${sku}`, { signal: ctx.signal, headers: jsonHeaders(product.url) }).catch(() => null),
    ]);
    assertHttp(stateRes, 'Best Buy stock check');
    if (stateRes.status >= 400) throw new RetailerError(`Best Buy stock check answered HTTP ${stateRes.status}`);
    const stateData = safeJson(stateRes);
    const state = firstString(findKey(stateData, 'buttonState'));
    if (!state) throw new RetailerError('Best Buy stock check returned no button state');
    const priceData = priceRes && priceRes.status < 400 ? safeJson(priceRes) : null;
    const price = firstNumber(findKey(priceData, 'currentPrice'));
    const title = firstString(findKey(findKey(priceData, 'names')[0], 'short'));
    return {
      inStock: c.inStockStates.includes(state.toUpperCase()),
      detail: state,
      url: product.url,
      ...(price !== undefined ? { price } : {}),
      ...(title ? { title } : {}),
    };
  }

  async function checkStock(ctx: MonitorContext, target: ProductTarget): Promise<StockResult> {
    const product = await withSku(ctx, target);
    const apiKey = ctx.settings.bestBuyApiKey;
    return apiKey ? stockFromOfficialApi(ctx, product, apiKey) : stockFromSite(ctx, product);
  }

  async function search(ctx: MonitorContext, query: KeywordQuery): Promise<SearchHit[]> {
    const c = cfg();
    const apiKey = ctx.settings.bestBuyApiKey;
    if (apiKey) {
      const terms = query.positive.map((t) => `search=${encodeURIComponent(t)}`).join('&');
      const url = `${c.officialApiUrl}((${terms}))?apiKey=${encodeURIComponent(apiKey)}&show=${OFFICIAL_FIELDS}&pageSize=25&format=json`;
      const res = await ctx.http.get(url, { signal: ctx.signal, headers: { accept: 'application/json' } });
      assertHttp(res, 'Best Buy API search');
      if (res.status >= 400) throw new RetailerError(`Best Buy API search answered HTTP ${res.status}`);
      const products = ((safeJson(res) as { products?: unknown[] })?.products ?? []) as unknown[];
      return products.flatMap((p): SearchHit[] => {
        const sku = digString(p, 'sku');
        const title = digString(p, 'name');
        if (!sku || !title) return [];
        const price = digNumber(p, 'salePrice');
        const image = digString(p, 'image');
        return [
          {
            productId: sku,
            title,
            url: digString(p, 'url') ?? canonicalProductUrl('bestbuy', sku),
            inStock: (p as { onlineAvailability?: unknown }).onlineAvailability === true,
            ...(price !== undefined ? { price } : {}),
            ...(image ? { imageUrl: image } : {}),
          },
        ];
      });
    }
    const res = await ctx.http.get(`${c.searchPageUrl}?st=${encodeURIComponent(searchText(query))}&intl=nosplash`, { signal: ctx.signal });
    assertHttp(res, 'Best Buy search');
    if (res.status >= 400) throw new RetailerError(`Best Buy search answered HTTP ${res.status}`);
    const root = parseHtml(res.text);
    const hits = new Map<string, SearchHit>();
    for (const item of root.querySelectorAll('[data-sku-id]')) {
      const sku = item.getAttribute('data-sku-id') ?? '';
      if (!BESTBUY_SKU.test(sku) || hits.has(sku)) continue;
      const title = textOf(item, ['.sku-title a', 'h4 a', 'h2 a', 'a[href*="skuId="]']);
      if (!title) continue;
      const priceText = textOf(item, ['.priceView-customer-price span', '[data-testid="customer-price"] span', '.priceView-hero-price span']);
      const price = priceText ? parsePrice(priceText) : null;
      const href = attrOf(item, ['.sku-title a', 'a[href*="skuId="]'], 'href');
      hits.set(sku, {
        productId: sku,
        title,
        url: href ? new URL(href, 'https://www.bestbuy.com').toString() : canonicalProductUrl('bestbuy', sku),
        ...(price !== null ? { price } : {}),
      });
    }
    return [...hits.values()];
  }

  /** Best Buy's sign-in state is not readable over plain HTTP; prepare() checks it in the window. */
  async function checkSignedIn(_ctx: SessionContext): Promise<boolean | null> {
    return null;
  }

  async function signIn(ctx: TaskContext): Promise<void> {
    await browserSignIn(ctx, {
      url: cfg().signInUrl,
      emailSelectors: ['#fld-e', 'input[name="fld-e"]', 'input[type="email"]'],
      passwordSelectors: ['#fld-p1', 'input[type="password"]'],
      submitText: '^(sign in|continue)$',
      passwordOptionText: 'use (a |your )?password|sign in with (a |your )?password',
      signedIn: async (page) => !/identity\/(?:global\/)?signin/i.test(page.url()) && !(await page.exists(['#fld-p1', 'input[type="password"]'])),
    });
  }

  async function prepare(ctx: TaskContext): Promise<void> {
    // Warm the session in the hidden window and sign in now rather than at drop time.
    const page = await ctx.page();
    await page.goto(cfg().accountUrl, ctx.signal);
    const snapshot = await assertPage(page, 'Best Buy account page');
    if (isSignInPage(snapshot)) {
      ctx.log('Best Buy session is signed out; signing in before the drop');
      await signIn(ctx);
      ctx.log('Signed in to Best Buy', 'success');
    }
  }

  async function addToCartHttp(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const res = await ctx.http.post(cfg().addToCartUrl, {
      signal: ctx.signal,
      headers: jsonHeaders(product.url),
      json: { items: [{ skuId: product.productId, quantity: ctx.task.quantity }] },
    });
    assertHttp(res, 'Best Buy add to cart');
    const data = safeJson(res);
    const errorCode = firstString(findKey(data, 'errorCode')) ?? '';
    if (res.status >= 200 && res.status < 300 && !errorCode) {
      const lines = findKey(data, 'summaryItems').find(Array.isArray) as unknown[] | undefined;
      const line = lines?.find((l) => firstString(findKey(l, 'skuId')) === product.productId);
      const quantity = firstNumber(findKey(line, 'quantity')) ?? ctx.task.quantity;
      if (quantity < ctx.task.quantity) ctx.log(`Best Buy added ${quantity} of ${ctx.task.quantity} (store limit)`, 'warn');
      return { quantity, via: 'http', detail: 'cart API', ...(stock.price !== undefined ? { unitPrice: stock.price } : {}) };
    }
    if (/CONSTRAINED_ITEM/i.test(errorCode)) throw new NeedsBrowserError('Best Buy is holding Add to Cart behind its wait queue');
    if (/MAX_QUANTITY|QUANTITY_LIMIT|LIMIT/i.test(errorCode)) {
      throw new PauseError('needs_review', `Best Buy limits the quantity for this item. Lower this task's quantity (now ${ctx.task.quantity}) and start it again.`);
    }
    if (/NOT_SELLABLE|SOLD_OUT|INVENTORY|UNAVAILABLE/i.test(errorCode) || looksOutOfStock(res.text)) {
      throw new OutOfStockError(`Best Buy could not add it (${errorCode || `HTTP ${res.status}`})`);
    }
    throw new NeedsBrowserError(`cart API answered ${errorCode || `HTTP ${res.status}`}`);
  }

  /** Product-page add to cart. A "Please Wait" button is Best Buy's queue: wait it out. */
  async function addToCartBrowser(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const c = cfg();
    const page = await ctx.page();
    await page.goto(product.url, ctx.signal);
    await assertPage(page, 'Best Buy product page');
    const first = await page.clickWhenReady({ selectors: c.addToCartSelectors, text: c.addToCartText }, { timeoutMs: 15_000, signal: ctx.signal });
    if (!first) {
      const snapshot = await assertPage(page, 'Best Buy product page');
      if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
      throw new RetailerError('Could not find Best Buy’s add-to-cart button');
    }
    const added = new RegExp(c.addedText, 'i');
    const waitPrompt = new RegExp(c.waitText, 'i');
    const started = Date.now();
    let waiting = false;
    for (;;) {
      await sleep(2000, ctx.signal);
      const snapshot = await assertPage(page, 'Best Buy add to cart');
      if (added.test(snapshot.text)) break;
      if (waitPrompt.test(snapshot.text)) {
        if (!waiting) {
          ctx.status('queued', 'Best Buy is holding Add to Cart ("Please Wait"). Waiting for the button, not skipping it.');
          ctx.notify('queue', 'Best Buy add-to-cart queue: waiting for the button to unlock.');
          waiting = true;
        }
        if (Date.now() - started > c.maxQueueWaitMs) throw new RetailerError('Best Buy’s add-to-cart queue did not open within 15 minutes');
        continue;
      }
      if (waiting) {
        // The wait is over and the button is live again: click it once, as a shopper would.
        waiting = false;
        const again = await page.click({ selectors: c.addToCartSelectors, text: c.addToCartText });
        if (again.clicked) {
          ctx.log('Best Buy released the add-to-cart button; clicked it');
          continue;
        }
      }
      if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
      if (Date.now() - started > 20_000) {
        ctx.log('Best Buy showed no add-to-cart confirmation; checkout will verify the cart', 'warn');
        break;
      }
    }
    return { quantity: 1, via: 'browser', detail: 'product page', ...(stock.price !== undefined ? { unitPrice: stock.price } : {}) };
  }

  async function addToCart(ctx: TaskContext, target: ProductTarget, stock: StockResult): Promise<CartResult> {
    const product = await withSku(ctx, target);
    try {
      return await addToCartHttp(ctx, product, stock);
    } catch (err) {
      if (!(err instanceof NeedsBrowserError)) throw err;
      ctx.log(`${err.message}; using the product page`, 'warn');
      return addToCartBrowser(ctx, product, stock);
    }
  }

  async function checkout(ctx: TaskContext): Promise<CheckoutResult> {
    const c = cfg();
    const page = await ctx.page();
    return browserCheckout(ctx, page, {
      startUrl: c.checkoutUrl,
      continueText: c.continueText,
      placeOrderText: c.placeOrderText,
      paymentSectionText: '^payment( information)?$',
      changePaymentText: '^(change|edit)$',
      confirmPaymentText: '^(use this card|apply|save|continue|done)$',
      confirmationUrl: new RegExp(c.confirmationUrlPattern, 'i'),
    });
  }

  return {
    id: 'bestbuy',
    monitorScope: 'shared',
    get homeUrl() {
      return cfg().homeUrl;
    },
    get signInUrl() {
      return cfg().signInUrl;
    },
    get signUpUrl() {
      return cfg().signUpUrl;
    },
    checkStock,
    search,
    checkSignedIn,
    signIn,
    prepare,
    addToCart,
    checkout,
  };
}
