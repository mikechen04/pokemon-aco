// Target
//   Stock + keyword search: Target's public "redsky" JSON endpoints (HTTP, no browser).
//   Add to cart: the cart API used by target.com (HTTP), falling back to the product page.
//   Checkout: target.com's own checkout page in the hidden window, where the saved card is
//   picked by its last 4 digits and everything is verified before "Place your order".
// Endpoints, the public web key and selectors live in DEFAULTS and can be overridden in
// retailer-overrides.json if Target changes them.
import { searchText, type KeywordQuery } from '../../shared/keywords';
import { canonicalProductUrl } from '../../shared/retailers';
import { FatalError, NeedsBrowserError, OutOfStockError, PauseError, RetailerError } from '../engine/errors';
import { looksOutOfStock } from '../engine/guards';
import type { HttpResponse } from '../engine/http';
import { assertHttp, assertPage, browserCheckout, browserSignIn } from './flows';
import { availabilityBuyable, decodeJwtPayload, findKey, firstNumber, firstString, jsonLdProducts, parseHtml } from './html';
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

export const TARGET_DEFAULTS = {
  /** Public key embedded in target.com pages for its redsky API. */
  apiKey: '9f36aeafbe60771e321a7cc95a78140772ab3e96',
  fulfillmentUrl: 'https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1',
  pdpUrl: 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1',
  searchUrl: 'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2',
  /** Optional store used for pricing in search; leave empty unless searches fail without it. */
  pricingStoreId: '',
  cartUrl: 'https://carts.target.com/web_checkouts/v1/cart',
  cartItemsUrl: 'https://carts.target.com/web_checkouts/v1/cart_items',
  homeUrl: 'https://www.target.com/',
  signInUrl:
    'https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_signin',
  checkoutPageUrl: 'https://www.target.com/checkout',
  channelId: '10',
  inStockStatuses: ['IN_STOCK', 'LIMITED_STOCK', 'PRE_ORDER_SELLABLE'],
  addToCartSelectors: ['button[data-test="shippingButton"]', 'button[data-test="addToCartButton"]', 'button[id^="addToCartButtonOrTextIdFor"]'],
  addToCartText: '^(add to cart|ship it|preorder|pre-order)$',
  placeOrderSelectors: ['button[data-test="placeOrderButton"]'],
  placeOrderText: '^place (your )?order$',
  continueText: '^(save and continue|continue|continue to payment|continue to review|review order)$',
  confirmationUrlPattern: 'co-thankyou|thank-?you|order-?confirmation',
};

type TargetConfig = typeof TARGET_DEFAULTS;

interface CachedDetails {
  at: number;
  title?: string;
  price?: number;
  imageUrl?: string;
}

const DETAILS_TTL_MS = 5 * 60_000;

function safeJson(res: HttpResponse): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function apiHeaders(referer: string): Record<string, string> {
  return {
    accept: 'application/json',
    origin: 'https://www.target.com',
    referer,
  };
}

export function createTarget(cfg: () => TargetConfig): RetailerModule {
  const details = new Map<string, CachedDetails>();

  /** Target's visitorId cookie; a first visit to target.com sets it. */
  async function visitorId(ctx: SessionContext): Promise<string> {
    const read = async () =>
      (await ctx.handle.session.cookies.get({ url: 'https://www.target.com', name: 'visitorId' }))[0]?.value ?? '';
    let id = await read();
    if (!id) {
      const res = await ctx.http.get(cfg().homeUrl, { signal: ctx.signal });
      assertHttp(res, 'Target home page');
      id = await read();
    }
    return id;
  }

  async function productDetails(ctx: MonitorContext, tcin: string, fresh: boolean): Promise<CachedDetails> {
    const cached = details.get(tcin);
    if (cached && !fresh && Date.now() - cached.at < DETAILS_TTL_MS) return cached;
    const c = cfg();
    const params = new URLSearchParams({ key: c.apiKey, tcin, is_bot: 'false', channel: 'WEB', page: `/p/A-${tcin}` });
    if (c.pricingStoreId) params.set('pricing_store_id', c.pricingStoreId);
    const res = await ctx.http.get(`${c.pdpUrl}?${params}`, { signal: ctx.signal, headers: apiHeaders(canonicalProductUrl('target', tcin)) });
    assertHttp(res, 'Target product details');
    const data = res.status < 400 ? safeJson(res) : null;
    const description = findKey(data, 'product_description')[0];
    const next: CachedDetails = {
      at: Date.now(),
      ...(firstString(findKey(description, 'title')) ? { title: firstString(findKey(description, 'title')) } : {}),
      ...(firstNumber([...findKey(data, 'current_retail'), ...findKey(data, 'formatted_current_price')]) !== undefined
        ? { price: firstNumber([...findKey(data, 'current_retail'), ...findKey(data, 'formatted_current_price')]) }
        : {}),
      ...(firstString(findKey(data, 'primary_image_url')) ? { imageUrl: firstString(findKey(data, 'primary_image_url')) } : {}),
    };
    details.set(tcin, next);
    return next;
  }

  async function checkStock(ctx: MonitorContext, product: ProductTarget): Promise<StockResult> {
    const c = cfg();
    const tcin = product.productId;
    const params = new URLSearchParams({ key: c.apiKey, tcin, is_bot: 'false', channel: 'WEB', page: `/p/A-${tcin}` });
    if (/^\d{5}$/.test(ctx.zip.slice(0, 5))) params.set('zip', ctx.zip.slice(0, 5));
    const visitor = await visitorId(ctx).catch(() => '');
    if (visitor) params.set('visitor_id', visitor);
    const res = await ctx.http.get(`${c.fulfillmentUrl}?${params}`, { signal: ctx.signal, headers: apiHeaders(product.url) });
    assertHttp(res, 'Target stock check');
    if (res.status === 404) throw new FatalError(`Target does not recognize TCIN ${tcin}`);
    const data = res.status < 400 ? safeJson(res) : null;
    // Online orders ship, so the shipping availability is the one that matters.
    const shipping = findKey(data, 'shipping_options');
    const status = firstString(shipping.flatMap((s) => findKey(s, 'availability_status'))) ?? firstString(findKey(data, 'availability_status'));
    if (!status) {
      // Fall back to the product page's structured data before giving up.
      const page = await ctx.http.get(product.url, { signal: ctx.signal });
      assertHttp(page, 'Target product page');
      const ld = jsonLdProducts(parseHtml(page.text))[0];
      const buyable = availabilityBuyable(ld?.availability);
      if (buyable === undefined) throw new RetailerError(`Target stock API answered HTTP ${res.status} without an availability status`);
      return {
        inStock: buyable,
        detail: ld?.availability ?? 'page',
        url: product.url,
        ...(ld?.price !== undefined ? { price: ld.price } : {}),
        ...(ld?.name ? { title: ld.name } : {}),
        ...(ld?.image ? { imageUrl: ld.image } : {}),
      };
    }
    const inStock = c.inStockStatuses.includes(status.toUpperCase());
    const info = await productDetails(ctx, tcin, inStock).catch(() => details.get(tcin));
    return {
      inStock,
      detail: status,
      url: product.url,
      ...(info?.price !== undefined ? { price: info.price } : {}),
      ...(info?.title ? { title: info.title } : {}),
      ...(info?.imageUrl ? { imageUrl: info.imageUrl } : {}),
    };
  }

  async function search(ctx: MonitorContext, query: KeywordQuery): Promise<SearchHit[]> {
    const c = cfg();
    const keyword = searchText(query);
    const params = new URLSearchParams({
      key: c.apiKey,
      channel: 'WEB',
      count: '24',
      default_purchasability_filter: 'true',
      keyword,
      offset: '0',
      page: `/s/${keyword}`,
      platform: 'desktop',
    });
    if (c.pricingStoreId) params.set('pricing_store_id', c.pricingStoreId);
    if (/^\d{5}$/.test(ctx.zip.slice(0, 5))) params.set('zip', ctx.zip.slice(0, 5));
    const visitor = await visitorId(ctx).catch(() => '');
    if (visitor) params.set('visitor_id', visitor);
    const res = await ctx.http.get(`${c.searchUrl}?${params}`, { signal: ctx.signal, headers: apiHeaders(`https://www.target.com/s?searchTerm=${encodeURIComponent(keyword)}`) });
    assertHttp(res, 'Target search');
    if (res.status >= 400) throw new RetailerError(`Target search answered HTTP ${res.status}`);
    const products = findKey(safeJson(res), 'products').find(Array.isArray) as unknown[] | undefined;
    const hits: SearchHit[] = [];
    for (const item of products ?? []) {
      const tcin = firstString(findKey(item, 'tcin'));
      const title = firstString(findKey(findKey(item, 'product_description')[0], 'title'));
      if (!tcin || !title) continue;
      const price = firstNumber([...findKey(item, 'current_retail'), ...findKey(item, 'formatted_current_price')]);
      const url = firstString(findKey(item, 'buy_url')) ?? canonicalProductUrl('target', tcin);
      const imageUrl = firstString(findKey(item, 'primary_image_url'));
      hits.push({ productId: tcin, title, url, ...(price !== undefined ? { price } : {}), ...(imageUrl ? { imageUrl } : {}) });
    }
    return hits;
  }

  async function checkSignedIn(ctx: SessionContext): Promise<boolean | null> {
    const cookies = await ctx.handle.session.cookies.get({ url: 'https://www.target.com' });
    const token = cookies.find((c) => c.name === 'accessToken')?.value;
    if (!token) return null;
    // Target's access token says whether the shopper is a guest ("G") or registered ("R").
    const userType = decodeJwtPayload(token)?.sut;
    if (userType === 'R') return true;
    if (userType === 'G') return false;
    return null;
  }

  async function signIn(ctx: TaskContext): Promise<void> {
    await browserSignIn(ctx, {
      url: cfg().signInUrl,
      emailSelectors: ['#username', 'input[name="username"]', 'input[type="email"]'],
      passwordSelectors: ['#password', 'input[type="password"]'],
      submitText: '^(sign in|continue|next)$',
      passwordOptionText: 'enter (your )?password|sign in with (a |your )?password|use (a |your )?password',
      signedIn: async (page) => !/\/login/i.test(page.url()) && !(await page.exists(['#username', 'input[type="password"]'])),
    });
  }

  async function prepare(ctx: TaskContext): Promise<void> {
    const c = cfg();
    await visitorId(ctx);
    // Look at the cart ahead of the drop: other items would make the subtotal check pause checkout.
    const res = await ctx.http.get(`${c.cartUrl}?cart_type=REGULAR&field_groups=CART%2CCART_ITEMS%2CSUMMARY&key=${c.apiKey}`, {
      signal: ctx.signal,
      headers: apiHeaders('https://www.target.com/cart'),
    });
    assertHttp(res, 'Target cart');
    if (res.status >= 400) return;
    const items = findKey(safeJson(res), 'cart_items').find(Array.isArray) as unknown[] | undefined;
    const others = (items ?? []).filter((i) => firstString(findKey(i, 'tcin')) !== ctx.task.productId).length;
    if (others > 0) ctx.log(`Your Target cart already has ${others} other item(s). Checkout pauses if the subtotal goes over your limit; consider emptying it.`, 'warn');
  }

  async function addToCartHttp(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const c = cfg();
    const res = await ctx.http.post(`${c.cartItemsUrl}?field_groups=CART%2CCART_ITEMS%2CSUMMARY&key=${c.apiKey}`, {
      signal: ctx.signal,
      headers: { ...apiHeaders(product.url), 'x-application-name': 'web' },
      json: {
        cart_type: 'REGULAR',
        channel_id: c.channelId,
        shopping_context: 'DIGITAL',
        cart_item: { tcin: product.productId, quantity: ctx.task.quantity, item_channel_id: c.channelId },
      },
    });
    assertHttp(res, 'Target add to cart');
    if (res.status >= 200 && res.status < 300) {
      const data = safeJson(res);
      const items = (findKey(data, 'cart_items').find(Array.isArray) as unknown[] | undefined) ?? [];
      const line = items.find((i) => firstString(findKey(i, 'tcin')) === product.productId);
      const unit = firstNumber([...findKey(line, 'current_retail'), ...findKey(line, 'unit_price')]) ?? stock.price;
      const quantity = firstNumber(findKey(line, 'quantity')) ?? ctx.task.quantity;
      const subtotal = firstNumber(findKey(data, 'total_product_amount'));
      return {
        quantity,
        via: 'http',
        detail: 'cart API',
        ...(unit !== undefined ? { unitPrice: unit } : {}),
        ...(subtotal !== undefined ? { subtotal } : {}),
      };
    }
    const text = res.text;
    if (/out[_\s-]?of[_\s-]?stock|not[_\s-]?available|unavailable|sold[_\s-]?out/i.test(text)) {
      throw new OutOfStockError('Target says the item cannot be added right now');
    }
    if (/limit|max(?:imum)?[_\s-]?(?:purchase|quantity)/i.test(text)) {
      throw new PauseError('needs_review', `Target limits how many of this item one order can have. Lower this task's quantity (now ${ctx.task.quantity}) and start it again.`);
    }
    throw new NeedsBrowserError(`cart API answered HTTP ${res.status}`);
  }

  async function addToCartBrowser(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const c = cfg();
    const page = await ctx.page();
    await page.goto(product.url, ctx.signal);
    await assertPage(page, 'Target product page');
    const clicked = await page.clickWhenReady({ selectors: c.addToCartSelectors, text: c.addToCartText }, { timeoutMs: 15_000, signal: ctx.signal });
    if (!clicked) {
      const snapshot = await assertPage(page, 'Target product page');
      if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
      throw new RetailerError('Could not find Target’s add-to-cart button');
    }
    await page.settle(ctx.signal, 1500, 10_000);
    const snapshot = await assertPage(page, 'Target add to cart');
    if (!/added to cart/i.test(snapshot.text) && looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    if (ctx.task.quantity > 1) ctx.log('Browser add-to-cart adds 1; checkout verifies the subtotal against your limit', 'warn');
    return { quantity: 1, via: 'browser', detail: 'product page', ...(stock.price !== undefined ? { unitPrice: stock.price } : {}) };
  }

  async function addToCart(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    try {
      return await addToCartHttp(ctx, product, stock);
    } catch (err) {
      if (!(err instanceof NeedsBrowserError)) throw err;
      ctx.log(`Target cart API unavailable (${err.message}); using the product page`, 'warn');
      return addToCartBrowser(ctx, product, stock);
    }
  }

  async function checkout(ctx: TaskContext): Promise<CheckoutResult> {
    const c = cfg();
    const page = await ctx.page();
    return browserCheckout(ctx, page, {
      startUrl: c.checkoutPageUrl,
      continueText: c.continueText,
      placeOrderText: c.placeOrderText,
      placeOrderSelectors: c.placeOrderSelectors,
      paymentSectionText: '^payment',
      changePaymentText: '^(change|edit)$',
      confirmPaymentText: '^(save and continue|use this card|save|continue|done)$',
      confirmationUrl: new RegExp(c.confirmationUrlPattern, 'i'),
    });
  }

  return {
    id: 'target',
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
  };
}
