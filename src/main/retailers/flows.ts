// Building blocks shared by the retailer modules: challenge handling, waiting rooms,
// sign-in, and a guarded checkout that verifies everything before placing an order.
import { formatUsd } from '../../shared/money';
import { RETAILERS } from '../../shared/retailers';
import type { BrowserPage } from '../engine/browser';
import { queueProgress, type PageKind } from '../engine/detection';
import {
  AbortedError,
  DeclinedError,
  errorMessage,
  NeedsSignInError,
  OutOfStockError,
  PauseError,
  PriceLimitError,
  QueueError,
  RetailerError,
  sleep,
  type PauseKind,
} from '../engine/errors';
import {
  addressMatches,
  checkSubtotal,
  extractOrderNumber,
  extractOrderTotal,
  extractSubtotal,
  looksDeclined,
  looksLikeConfirmation,
  looksLikeCvvPrompt,
  looksOutOfStock,
  mentionsCardLast4,
} from '../engine/guards';
import type { HttpResponse } from '../engine/http';
import type { PageSnapshot } from '../engine/pageScripts';
import type { CheckoutResult, TaskContext } from './types';

const PAUSE_FOR: Partial<Record<PageKind, PauseKind>> = {
  captcha: 'captcha',
  bot_challenge: 'bot_challenge',
  blocked: 'blocked',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Turns a challenge, block, queue or rate limit in an HTTP response into the right error. */
export function assertHttp(res: HttpResponse, step: string): void {
  const d = res.detection;
  if (res.status === 401) throw new RetailerError(`${step}: not signed in (HTTP 401)`);
  if (d.kind === 'queue') throw new QueueError(d.detail, res.url);
  const pause = PAUSE_FOR[d.kind];
  if (pause) {
    throw new PauseError(
      pause,
      `${step}: ${d.detail} from ${hostOf(res.url)}. The app does not try to get past it; wait a while or continue by hand, then press Start.`,
    );
  }
  if (d.kind === 'rate_limited') throw new RetailerError(`${step}: ${hostOf(res.url)} asked us to slow down`, d.retryAfterMs ?? 30_000);
  if (d.kind === 'server_error') throw new RetailerError(`${step}: ${hostOf(res.url)} returned ${d.detail}`);
}

/** Checks what the hidden window shows. Pauses (with the window kept for you) on any challenge. */
export async function assertPage(page: BrowserPage, step: string): Promise<PageSnapshot> {
  const d = await page.detect();
  if (d.kind === 'queue') throw new QueueError(queueProgress(d.snapshot.text) ?? d.detail, d.snapshot.url);
  const pause = PAUSE_FOR[d.kind];
  if (pause) {
    throw new PauseError(pause, `${step}: ${d.detail}. Open the window to handle it yourself, then press Start.`, true);
  }
  return d.snapshot;
}

export function ensurePrice(price: number | undefined, ctx: TaskContext): void {
  if (price !== undefined && price > ctx.task.maxPrice) throw new PriceLimitError(price, ctx.task.maxPrice);
}

/** Safe nested lookup in untyped JSON: dig(obj, 'data', 'product', 0, 'price'). */
export function dig(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

export function digString(value: unknown, ...path: Array<string | number>): string | undefined {
  const found = dig(value, ...path);
  return typeof found === 'string' ? found : typeof found === 'number' ? String(found) : undefined;
}

export function digNumber(value: unknown, ...path: Array<string | number>): number | undefined {
  const found = dig(value, ...path);
  if (typeof found === 'number' && Number.isFinite(found)) return found;
  if (typeof found === 'string' && found.trim() !== '' && Number.isFinite(Number(found))) return Number(found);
  return undefined;
}

/**
 * Waits in a waiting room until it lets this session through. The page refreshes itself;
 * we only read it. Reloading or skipping could cost the place in line, so neither happens.
 */
export async function waitInWaitingRoom(ctx: TaskContext, page: BrowserPage, label: string): Promise<void> {
  const started = Date.now();
  let notified = false;
  let lastProgress: string | null = null;
  for (;;) {
    const d = await page.detect();
    const pause = PAUSE_FOR[d.kind];
    if (pause) {
      throw new PauseError(
        pause,
        `The ${label} waiting room is asking for verification (${d.detail}). Open the window and complete it yourself; the window keeps its place in line. Then press Start.`,
        true,
      );
    }
    if (d.kind !== 'queue') {
      const minutes = Math.max(1, Math.round((Date.now() - started) / 60_000));
      ctx.log(`Through the ${label} waiting room after about ${minutes} min`, 'success');
      return;
    }
    const progress = queueProgress(d.snapshot.text);
    if (!notified) {
      ctx.notify('queue', `In the ${label} waiting room. This task continues on its own when the queue lets it through.`);
      notified = true;
    }
    if (progress !== lastProgress) {
      ctx.status('queued', `In ${label} waiting room${progress ? ` (${progress})` : ''}`);
      lastProgress = progress;
    }
    await sleep(4000, ctx.signal);
  }
}

const OTP_TEXT =
  /(?:enter|type) (?:the |your )?(?:verification|security|one[- ]time|6-digit|six-digit) code|we (?:sent|texted|emailed) (?:you )?a code|two-step verification|2-step verification|approve (?:the )?(?:notification|sign-in)|check your (?:email|phone) for/i;

export interface SignInOptions {
  url: string;
  emailSelectors: string[];
  passwordSelectors: string[];
  /** Regex source for "Continue" / "Sign in" buttons. */
  submitText: string;
  submitSelectors?: string[];
  /** Regex source for a "use my password instead" option on passwordless-first logins. */
  passwordOptionText?: string;
  /** If `url` shows no sign-in form, open `homeUrl` and click a link matching this instead. */
  entryLinkText?: string;
  homeUrl?: string;
  /** True once the page shows a signed-in state. */
  signedIn: (page: BrowserPage) => Promise<boolean>;
}

/**
 * Generic sign-in in the account's hidden window. Fills the saved email and password; any
 * verification code, CAPTCHA or approval prompt pauses the task for the user.
 */
export async function browserSignIn(ctx: TaskContext, options: SignInOptions): Promise<void> {
  const label = RETAILERS[ctx.task.retailer].name;
  if (!ctx.account.password) {
    throw new PauseError('sign_in_required', `No password saved for this ${label} account. Use Accounts → Sign in to sign in by hand, then press Start.`);
  }
  const page = await ctx.page();
  await page.goto(options.url, ctx.signal);
  if (options.entryLinkText && options.homeUrl) {
    const formShown = await page.waitFor(
      async () => (await page.exists([...options.emailSelectors, ...options.passwordSelectors])) || (await options.signedIn(page)),
      { timeoutMs: 6000, signal: ctx.signal },
    );
    if (!formShown) {
      await page.goto(options.homeUrl, ctx.signal);
      await assertPage(page, `${label} home page`);
      if ((await page.click({ text: options.entryLinkText })).clicked) await page.settle(ctx.signal);
    }
  }
  for (let step = 0; step < 8; step++) {
    const snapshot = await assertPage(page, `${label} sign-in`);
    if (await options.signedIn(page)) return;
    const otpField = await page.exists([
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
      'input[name*="code" i][inputmode="numeric"]',
    ]);
    if (otpField || OTP_TEXT.test(snapshot.text)) {
      throw new PauseError(
        'two_factor',
        `${label} wants a verification code or approval. Open the window, finish it there, then press Start.`,
        true,
      );
    }
    const submit = async () => {
      const byText = await page.click({ text: options.submitText });
      if (!byText.clicked) await page.click({ selectors: options.submitSelectors ?? ['button[type="submit"]', 'input[type="submit"]'] });
      await page.settle(ctx.signal);
    };
    if (await page.exists(options.passwordSelectors)) {
      await page.fill(options.emailSelectors, ctx.account.email);
      await page.fill(options.passwordSelectors, ctx.account.password);
      await submit();
      continue;
    }
    if (await page.exists(options.emailSelectors)) {
      await page.fill(options.emailSelectors, ctx.account.email);
      await submit();
      continue;
    }
    if (options.passwordOptionText && (await page.click({ text: options.passwordOptionText })).clicked) {
      await page.settle(ctx.signal);
      continue;
    }
    await sleep(1500, ctx.signal);
  }
  if (!(await options.signedIn(page))) {
    throw new PauseError(
      'sign_in_required',
      `Could not finish signing in to ${label} automatically. Open the window to sign in by hand, then press Start.`,
      true,
    );
  }
}

export interface BrowserCheckoutOptions {
  /** Open this page first (e.g. the cart or checkout URL). */
  startUrl?: string;
  /** Regex source for buttons that move from the cart/shipping steps to the review page. */
  continueText?: string;
  placeOrderText: string;
  placeOrderSelectors?: string[];
  paymentSectionText: string;
  changePaymentText: string;
  confirmPaymentText: string;
  confirmationUrl: RegExp;
  /** How many intermediate pages to click through before the review page. */
  maxSteps?: number;
}

async function selectSavedCard(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions): Promise<void> {
  const last4 = ctx.profile.cardLast4;
  ctx.log(`Selecting the saved card ending in ${last4}`);
  let selection = await page.selectCard(last4);
  if (!selection.found) {
    const opened = await page.click({ within: options.paymentSectionText, text: options.changePaymentText });
    if (!opened.clicked) return;
    await page.settle(ctx.signal, 800, 8000);
    selection =
      (await page.waitFor(
        async () => {
          const s = await page.selectCard(last4);
          return s.found ? s : null;
        },
        { timeoutMs: 8000, signal: ctx.signal },
      )) ?? selection;
    if (!selection.found) return;
  }
  await page.settle(ctx.signal, 500, 5000);
  await page.click({ text: options.confirmPaymentText });
  await page.settle(ctx.signal, 800, 10_000);
}

/** Pauses when the page wants a CVV or card number typed in: the app never handles card data. */
export async function assertNoCardEntry(ctx: TaskContext, page: BrowserPage, text: string): Promise<void> {
  const label = RETAILERS[ctx.task.retailer].name;
  const entry = await page.cardEntryVisible();
  if (entry === 'card') {
    throw new PauseError(
      'cvv_required',
      `${label} is asking for a card number, which means no saved card ending in ${ctx.profile.cardLast4} is usable here. The app never enters card data: save the card on your ${label} account, or finish in the window.`,
      true,
    );
  }
  if (entry === 'cvv' || looksLikeCvvPrompt(text)) {
    throw new PauseError(
      'cvv_required',
      `${label} is asking for the card's security code. The app never handles card data: open the window, enter it yourself and place the order there.`,
      true,
    );
  }
}

const SIGN_IN_URL = /sign-?in|log-?in|\/ap\/signin|identity\/(?:global\/)?signin|account\/login/i;

/** True when the window was sent to a sign-in page. */
export function isSignInPage(snapshot: PageSnapshot): boolean {
  return SIGN_IN_URL.test(snapshot.url) && /sign in|log in|password/i.test(snapshot.text);
}

/** Verifies card, address and subtotal on the review page. Pauses (never buys) when unsure. */
export async function verifyReviewPage(
  ctx: TaskContext,
  page: BrowserPage,
  options: BrowserCheckoutOptions,
): Promise<{ snapshot: PageSnapshot; subtotal: number | null }> {
  const label = RETAILERS[ctx.task.retailer].name;
  const { profile, task } = ctx;
  let snapshot = await assertPage(page, 'Checkout');

  if (!mentionsCardLast4(snapshot.text, profile.cardLast4)) {
    await selectSavedCard(ctx, page, options);
    snapshot = await assertPage(page, 'Checkout');
    if (!mentionsCardLast4(snapshot.text, profile.cardLast4)) {
      throw new PauseError(
        'needs_review',
        `Could not confirm that the saved card ending in ${profile.cardLast4} is selected on ${label}. Open the window to pick it, or check the profile's last 4 digits.`,
        true,
      );
    }
  }
  await assertNoCardEntry(ctx, page, snapshot.text);
  if (!addressMatches(snapshot.text, profile.shipping)) {
    throw new PauseError(
      'needs_review',
      `The ship-to address on the ${label} checkout page does not match profile "${profile.name}" (ZIP ${profile.shipping.zip}). Save that address on your ${label} account, or open the window.`,
      true,
    );
  }
  const subtotal = extractSubtotal(snapshot.text);
  const check = checkSubtotal(subtotal, task.maxPrice, task.quantity);
  if (!check.ok) throw new PauseError('needs_review', `${check.message}. Nothing was ordered.`, true);
  ctx.log(`Verified card ending in ${profile.cardLast4}, ship-to ZIP ${profile.shipping.zip}, ${check.message.toLowerCase()}`);
  return { snapshot, subtotal };
}

/**
 * After an order is submitted, uncertainty must never lead to a retry (that could buy twice).
 * Any unexpected error here becomes a pause for the user to check their orders.
 */
export async function afterSubmit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PauseError || err instanceof DeclinedError || err instanceof AbortedError) throw err;
    throw new PauseError(
      'needs_review',
      `The order was submitted but the result is unclear (${errorMessage(err)}). Check your order history before starting this task again.`,
      true,
    );
  }
}

export async function awaitConfirmation(ctx: TaskContext, page: BrowserPage, confirmationUrl: RegExp): Promise<CheckoutResult> {
  return afterSubmit(async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(1500, ctx.signal);
      const d = await page.detect();
      const { text, url } = d.snapshot;
      if (confirmationUrl.test(url) || looksLikeConfirmation(url, text)) {
        const orderNumber = extractOrderNumber(text) ?? undefined;
        const total = extractOrderTotal(text) ?? undefined;
        return {
          placed: true,
          ...(orderNumber ? { orderNumber } : {}),
          ...(total !== undefined ? { total } : {}),
          detail: `Order placed${orderNumber ? ` (#${orderNumber})` : ''}${total !== undefined ? `, total ${formatUsd(total)}` : ''}`,
        };
      }
      if (looksDeclined(text)) throw new DeclinedError(`${RETAILERS[ctx.task.retailer].name} declined the card ending in ${ctx.profile.cardLast4}`);
      const pause = PAUSE_FOR[d.kind];
      if (pause) {
        throw new PauseError(pause, 'A verification appeared after the order was submitted. Open the window to finish, and check your orders before restarting.', true);
      }
      if (await page.cardEntryVisible()) {
        throw new PauseError('cvv_required', 'The retailer asked for card details after submitting. Open the window to finish the order yourself.', true);
      }
    }
    throw new PauseError(
      'needs_review',
      'The order was submitted but no confirmation appeared within 2 minutes. Check your order history before starting this task again.',
      true,
    );
  });
}

/** The full browser checkout from the current page: step to review, verify, then place. */
export async function browserCheckout(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions): Promise<CheckoutResult> {
  if (options.startUrl) await page.goto(options.startUrl, ctx.signal);
  const hasPlaceOrder = async () =>
    (options.placeOrderSelectors ? await page.exists(options.placeOrderSelectors) : false) ||
    (await page.tryEvaluate(
      false,
      (source: string) =>
        Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).some((el) =>
          new RegExp(source, 'i').test(((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').trim()),
        ),
      options.placeOrderText,
    ));

  for (let step = 0; step < (options.maxSteps ?? 4); step++) {
    const snapshot = await assertPage(page, 'Checkout');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();
    if (await hasPlaceOrder()) break;
    if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    if (!options.continueText) break;
    const next = await page.click({ text: options.continueText });
    if (!next.clicked) break;
    ctx.log(`Checkout: ${next.label}`);
    await page.settle(ctx.signal);
  }
  if (!(await hasPlaceOrder())) {
    const snapshot = await assertPage(page, 'Checkout');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();
    await assertNoCardEntry(ctx, page, snapshot.text);
    if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    throw new RetailerError('Could not reach the order review page (no place-order button found)');
  }

  const { subtotal } = await verifyReviewPage(ctx, page, options);
  if (ctx.dryRun) {
    return {
      placed: false,
      detail: `Dry run: card ending in ${ctx.profile.cardLast4}, ZIP ${ctx.profile.shipping.zip} and subtotal ${formatUsd(subtotal)} verified. Order not placed.`,
    };
  }
  ctx.beforePlaceOrder();
  ctx.status('checking_out', 'Placing order');
  const submitted = await page.click({ ...(options.placeOrderSelectors ? { selectors: options.placeOrderSelectors } : {}), text: options.placeOrderText });
  if (!submitted.clicked) throw new RetailerError('The place-order button could not be clicked');
  ctx.log(`Clicked "${submitted.label || 'Place order'}", waiting for confirmation`);
  return awaitConfirmation(ctx, page, options.confirmationUrl);
}
