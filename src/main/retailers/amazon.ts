// Amazon (amazon.com)
//   Stock + search: the product and search pages over HTTP (no browser), including who
//   sells the buy-box offer, so third-party scalper listings can be skipped.
//   Purchase: "Buy Now" on the product page in the hidden window, so only this item is
//   bought (other things in your cart are untouched). Amazon's Buy Now panel or checkout
//   page is verified (card last 4, ship-to ZIP, subtotal) before "Place your order".
import { searchText, type KeywordQuery } from '../../shared/keywords';
import { formatUsd, parsePrice } from '../../shared/money';
import { canonicalProductUrl } from '../../shared/retailers';
import type { BrowserPage } from '../engine/browser';
import { DeclinedError, NeedsSignInError, OutOfStockError, PauseError, RetailerError, sleep } from '../engine/errors';
import {
  addressMatches,
  checkSubtotal,
  extractOrderNumber,
  extractSubtotal,
  looksDeclined,
  looksLikeConfirmation,
  looksOutOfStock,
  mentionsCardLast4,
} from '../engine/guards';
import { afterSubmit, assertHttp, assertPage, browserCheckout, browserSignIn, ensurePrice, isSignInPage, type BrowserCheckoutOptions } from './flows';
import { attrOf, parseHtml, textOf } from './html';
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

export const AMAZON_DEFAULTS = {
  homeUrl: 'https://www.amazon.com/',
  searchUrl: 'https://www.amazon.com/s',
  cartUrl: 'https://www.amazon.com/gp/cart/view.html',
  signInUrl:
    'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
  /** Amazon.com's own seller id (the "Sold by Amazon.com" offer). */
  amazonSellerId: 'ATVPDKIKX0DER',
  titleSelectors: ['#productTitle'],
  priceSelectors: [
    '#corePrice_feature_div .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#tp_price_block_total_price_ww .a-offscreen',
    '#price_inside_buybox',
    '#priceblock_ourprice',
  ],
  availabilitySelectors: ['#availability'],
  addToCartSelectors: ['#add-to-cart-button'],
  buyNowSelectors: ['#buy-now-button', 'input[name="submit.buy-now"]'],
  merchantIdSelectors: ['#merchantID', 'input[name="merchantID"]', 'input[name="items[0.base][merchantId]"]'],
  merchantTextSelectors: ['#merchantInfoFeature_feature_div', '#merchant-info', '#tabular-buybox', '#sellerProfileTriggerId'],
  imageSelectors: ['#landingImage', '#imgBlkFront'],
  quantitySelectors: ['select#quantity', 'select[name="quantity"]'],
  navGreetingSelectors: ['#nav-link-accountList-nav-line-1', '#glow-ingress-line1'],
  turboFrameSelector: '#turbo-checkout-iframe',
  turboPlaceOrderSelectors: ['#turbo-checkout-pyo-button', 'input#turbo-checkout-pyo-button', 'input[name="placeYourOrder1"]'],
  placeOrderSelectors: ['#submitOrderButtonId input', 'input[name="placeYourOrder1"]', '#placeYourOrder input', '#bottomSubmitOrderButtonId input'],
  placeOrderText: '^place (your )?order',
  continueText: '^(proceed to checkout|continue|use this address|use this payment method)$',
  confirmationUrlPattern: 'thankyou|thank-you|order-confirmation',
};

type AmazonConfig = typeof AMAZON_DEFAULTS;

const SOLD_BY_AMAZON = /sold by\s*:?\s*amazon(?:\.com)?\b/i;

function soldByAmazon(merchantId: string | undefined, merchantText: string | undefined, amazonId: string): boolean | undefined {
  if (merchantId) return merchantId === amazonId;
  if (merchantText) return SOLD_BY_AMAZON.test(merchantText);
  return undefined;
}

export function createAmazon(cfg: () => AmazonConfig): RetailerModule {
  function productUrl(asin: string): string {
    return `${canonicalProductUrl('amazon', asin)}?th=1&psc=1`;
  }

  async function checkStock(ctx: MonitorContext, product: ProductTarget): Promise<StockResult> {
    const c = cfg();
    const res = await ctx.http.get(productUrl(product.productId), { signal: ctx.signal });
    assertHttp(res, 'Amazon stock check');
    if (res.status === 404) throw new RetailerError(`Amazon has no product page for ASIN ${product.productId}`);
    if (res.status >= 400) throw new RetailerError(`Amazon answered HTTP ${res.status}`);
    const root = parseHtml(res.text);
    const title = textOf(root, c.titleSelectors);
    if (!title) throw new RetailerError('Amazon returned a page without product details');
    const availability = textOf(root, c.availabilitySelectors) ?? '';
    const buyable = c.addToCartSelectors.concat(c.buyNowSelectors).some((s) => root.querySelector(s));
    const priceText = textOf(root, c.priceSelectors);
    const price = priceText ? parsePrice(priceText) : null;
    const sold = soldByAmazon(attrOf(root, c.merchantIdSelectors, 'value'), textOf(root, c.merchantTextSelectors), c.amazonSellerId);
    const image = attrOf(root, c.imageSelectors, 'data-old-hires') ?? attrOf(root, c.imageSelectors, 'src');
    const unavailable = /currently unavailable|temporarily out of stock|out of stock/i.test(availability);
    return {
      inStock: buyable && !unavailable,
      detail: availability.slice(0, 60) || (buyable ? 'buy box' : 'no buy box'),
      title,
      url: canonicalProductUrl('amazon', product.productId),
      ...(price !== null ? { price } : {}),
      ...(image ? { imageUrl: image } : {}),
      ...(sold !== undefined ? { soldByRetailer: sold } : {}),
    };
  }

  async function search(ctx: MonitorContext, query: KeywordQuery): Promise<SearchHit[]> {
    const res = await ctx.http.get(`${cfg().searchUrl}?k=${encodeURIComponent(searchText(query))}`, { signal: ctx.signal });
    assertHttp(res, 'Amazon search');
    if (res.status >= 400) throw new RetailerError(`Amazon search answered HTTP ${res.status}`);
    const root = parseHtml(res.text);
    const hits: SearchHit[] = [];
    for (const item of root.querySelectorAll('div[data-component-type="s-search-result"][data-asin]')) {
      const asin = item.getAttribute('data-asin') ?? '';
      if (!/^[A-Z0-9]{10}$/i.test(asin)) continue;
      const title = textOf(item, ['h2 span', 'h2']);
      if (!title) continue;
      const priceText = textOf(item, ['.a-price .a-offscreen']);
      const price = priceText ? parsePrice(priceText) : null;
      const image = attrOf(item, ['img.s-image'], 'src');
      hits.push({
        productId: asin.toUpperCase(),
        title,
        url: canonicalProductUrl('amazon', asin.toUpperCase()),
        ...(price !== null ? { price } : {}),
        ...(image ? { imageUrl: image } : {}),
      });
    }
    return hits;
  }

  async function checkSignedIn(ctx: SessionContext): Promise<boolean | null> {
    const res = await ctx.http.get(cfg().cartUrl, { signal: ctx.signal });
    assertHttp(res, 'Amazon session check');
    if (res.status >= 400) return null;
    const greeting = textOf(parseHtml(res.text), cfg().navGreetingSelectors);
    if (!greeting) return null;
    return !/sign in/i.test(greeting);
  }

  async function signIn(ctx: TaskContext): Promise<void> {
    await browserSignIn(ctx, {
      url: cfg().signInUrl,
      emailSelectors: ['#ap_email', 'input[name="email"]', 'input[type="email"]'],
      passwordSelectors: ['#ap_password', 'input[name="password"]'],
      submitText: '^(continue|sign in|next)$',
      submitSelectors: ['#continue', '#signInSubmit', 'input[type="submit"]'],
      signedIn: async (page) =>
        /amazon\.com/i.test(page.url()) && !/\/ap\/(signin|mfa|cvf)/i.test(page.url()) && !(await page.exists(['#ap_email', '#ap_password'])),
    });
  }

  async function prepare(ctx: TaskContext): Promise<void> {
    // Warm the account's session on the product page ahead of the drop (cookies, connections).
    if (!ctx.task.productId) return;
    const res = await ctx.http.get(productUrl(ctx.task.productId), { signal: ctx.signal });
    assertHttp(res, 'Amazon product page');
  }

  /** Opens the product page signed in, checks seller and price, and readies "Buy Now". */
  async function addToCart(ctx: TaskContext, product: ProductTarget, stock: StockResult): Promise<CartResult> {
    const c = cfg();
    const page = await ctx.page();
    await page.goto(productUrl(product.productId), ctx.signal);
    const snapshot = await assertPage(page, 'Amazon product page');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();
    if (ctx.settings.amazonSoldByAmazonOnly) {
      const merchantId = await page.tryEvaluate(
        '',
        (selectors: string[]) => {
          for (const s of selectors) {
            const el = document.querySelector(s) as HTMLInputElement | null;
            if (el?.value) return el.value;
          }
          return '';
        },
        c.merchantIdSelectors,
      );
      const merchantText = (await page.readText(c.merchantTextSelectors)) ?? undefined;
      if (soldByAmazon(merchantId || undefined, merchantText, c.amazonSellerId) === false) {
        throw new OutOfStockError('Only a third-party seller has it right now ("Sold by Amazon only" is on)');
      }
    }
    const priceText = await page.readText(c.priceSelectors);
    const price = priceText ? (parsePrice(priceText) ?? undefined) : stock.price;
    ensurePrice(price, ctx);

    let quantity = ctx.task.quantity;
    if (quantity > 1 && !(await page.selectValue(c.quantitySelectors, String(quantity)))) {
      ctx.log(`Amazon does not offer quantity ${quantity} for this item; buying 1`, 'warn');
      quantity = 1;
    }
    if (await page.exists(c.buyNowSelectors)) {
      ctx.memo.set('amazon:route', 'buy-now');
      return { quantity, via: 'browser', detail: 'Buy Now ready', ...(price !== undefined ? { unitPrice: price } : {}) };
    }
    // No Buy Now button (some listings): use the cart instead.
    const added = await page.click({ selectors: c.addToCartSelectors });
    if (!added.clicked) {
      if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
      throw new RetailerError('Amazon shows neither Buy Now nor Add to Cart');
    }
    await page.settle(ctx.signal);
    ctx.memo.set('amazon:route', 'cart');
    return { quantity, via: 'browser', detail: 'added to cart', ...(price !== undefined ? { unitPrice: price } : {}) };
  }

  function spcOptions(c: AmazonConfig, startUrl?: string): BrowserCheckoutOptions {
    return {
      ...(startUrl ? { startUrl } : {}),
      continueText: c.continueText,
      placeOrderText: c.placeOrderText,
      placeOrderSelectors: c.placeOrderSelectors,
      paymentSectionText: 'payment method',
      changePaymentText: '^change$',
      confirmPaymentText: '^use this payment method$',
      confirmationUrl: new RegExp(c.confirmationUrlPattern, 'i'),
    };
  }

  /** Amazon's one-click "Buy Now" panel: verify what it shows, then place the order in it. */
  async function turboCheckout(ctx: TaskContext, page: BrowserPage, cart: CartResult): Promise<CheckoutResult> {
    const c = cfg();
    const { profile, task } = ctx;
    const text = (await page.waitFor(
      async () => {
        const t = await page.frameText(c.turboFrameSelector);
        return t.length > 40 ? t : null;
      },
      { timeoutMs: 15_000, signal: ctx.signal },
    )) ?? '';
    const subtotal = extractSubtotal(text);
    const priceCheck = checkSubtotal(subtotal, task.maxPrice, cart.quantity);
    const problem = !mentionsCardLast4(text, profile.cardLast4)
      ? `shows a card other than the one ending in ${profile.cardLast4}`
      : !addressMatches(text, profile.shipping)
        ? `ships to an address that does not match profile "${profile.name}"`
        : !priceCheck.ok
          ? `could not be price-checked (${priceCheck.message})`
          : null;
    if (problem) {
      throw new PauseError(
        'needs_review',
        `Amazon's Buy Now panel ${problem}. Nothing was ordered. Make the matching card/address your Amazon default, or open the window to review.`,
        true,
      );
    }
    if (ctx.dryRun) {
      return { placed: false, detail: `Dry run: Buy Now panel shows card ending in ${profile.cardLast4}, ZIP ${profile.shipping.zip}, ${priceCheck.message.toLowerCase()}. Order not placed.` };
    }
    ctx.beforePlaceOrder();
    ctx.status('checking_out', 'Placing order');
    if (!(await page.frameClick(c.turboFrameSelector, c.turboPlaceOrderSelectors))) {
      throw new RetailerError('Could not click "Place your order" in Amazon’s Buy Now panel');
    }
    ctx.log(`Placed from Amazon's Buy Now panel (subtotal ${formatUsd(subtotal)}), waiting for confirmation`);
    return afterSubmit(async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await sleep(1500, ctx.signal);
        const frame = await page.frameText(c.turboFrameSelector);
        const main = await page.snapshot();
        const combined = `${frame}\n${main.text}`;
        if (looksLikeConfirmation(main.url, combined) || /order placed/i.test(frame)) {
          const orderNumber = extractOrderNumber(combined) ?? undefined;
          return { placed: true, ...(orderNumber ? { orderNumber } : {}), detail: `Order placed${orderNumber ? ` (#${orderNumber})` : ''}` };
        }
        if (looksDeclined(combined)) throw new DeclinedError(`Amazon declined the card ending in ${profile.cardLast4}`);
      }
      throw new PauseError('needs_review', 'Amazon did not confirm the order within 2 minutes. Check Your Orders before starting this task again.', true);
    });
  }

  async function checkout(ctx: TaskContext, product: ProductTarget, _stock: StockResult, cart: CartResult): Promise<CheckoutResult> {
    const c = cfg();
    const page = await ctx.page();
    if (ctx.memo.get('amazon:route') === 'cart') return browserCheckout(ctx, page, spcOptions(c, c.cartUrl));
    if (!page.url().includes(product.productId)) await page.goto(productUrl(product.productId), ctx.signal);
    const clicked = await page.click({ selectors: c.buyNowSelectors });
    if (!clicked.clicked) {
      const snapshot = await assertPage(page, 'Amazon product page');
      if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
      throw new RetailerError('Amazon’s Buy Now button disappeared');
    }
    const mode = await page.waitFor(
      async () => {
        if (await page.exists([c.turboFrameSelector])) return 'turbo';
        if (/\/(gp\/buy|checkout)\//i.test(page.url())) return 'checkout';
        const snapshot = await page.snapshot();
        if (isSignInPage(snapshot)) return 'signin';
        return null;
      },
      { timeoutMs: 20_000, signal: ctx.signal },
    );
    if (mode === 'signin') throw new NeedsSignInError();
    if (mode === 'turbo') return turboCheckout(ctx, page, cart);
    if (mode === 'checkout') return browserCheckout(ctx, page, spcOptions(c));
    const snapshot = await assertPage(page, 'Amazon checkout');
    if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    throw new RetailerError('Amazon did not open checkout after Buy Now');
  }

  return {
    id: 'amazon',
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
