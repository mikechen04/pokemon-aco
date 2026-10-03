// Building blocks shared by the retailer modules: challenge handling, waiting rooms,
// sign-in, and a guarded checkout that verifies everything before placing an order.
import { cardExpired, digitsOnly, formatExpiry } from '../../shared/cards';
import { US_STATE_NAMES } from '../../shared/constants';
import { formatUsd } from '../../shared/money';
import { RETAILERS } from '../../shared/retailers';
import type { Address } from '../../shared/types';
import type { StoredCard } from '../data/cards';
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
  mentionsOtherCard,
} from '../engine/guards';
import { emptyFillReport, type FillAddress, type FillReport, type FillRequest } from '../engine/fillScripts';
import type { HttpResponse } from '../engine/http';
import type { ClickTarget, PageSnapshot } from '../engine/pageScripts';
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
  /** Regex source for the link that opens a new-card form (defaults to common "Add a card" labels). */
  addCardText?: string;
  /** How many intermediate pages to click through before the review page. */
  maxSteps?: number;
}

/** What happened earlier in this checkout. */
export interface CheckoutState {
  /** The stored card was typed into a payment form. */
  cardTyped: boolean;
}

const ADD_CARD_TEXT =
  '^\\+?\\s*(add|enter|use)( a)?( new| another| different)? (credit or debit card|credit/debit card|credit card|debit card|card|payment card|payment method)$';
/** Buttons that save a form the app just filled in (never the place-order button). */
const SAVE_FORM_TEXT =
  '^(save|save (and|&) continue|continue|next|done|use this address|ship to this address|deliver to this address|ship here|deliver here|save address|use this card|save card|add (your|this|my) card)$';

/** Payment processors whose secure card fields may receive the stored card. */
const PAYMENT_FRAME_HOSTS =
  /(?:^|\.)(?:cybersource\.com|cardinalcommerce\.com|adyen\.com|braintreegateway\.com|braintree-api\.com|stripe\.com|paypal\.com|paymentech\.com|chasepaymentech\.com|worldpay\.com|spreedly\.com|tokenex\.com|recurly\.com|vantiv\.com|elavon\.com|firstdata\.com|globalpay\.com|squareup\.com|checkout\.com|bluesnap\.com|authorize\.net)$/i;

const CARD_PART_LABELS = { number: 'card number', exp: 'expiry date', cvv: 'security code', name: 'name on card' } as const;

type CardMode = 'none' | 'full' | 'cvv';

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isRetailerHost(ctx: TaskContext, host: string): boolean {
  return RETAILERS[ctx.task.retailer].hosts.some((domain) => hostMatches(host, domain));
}

/** Forms are only filled on the store's own site (or where its checkout is configured to start). */
function onCheckoutHost(ctx: TaskContext, host: string, options: BrowserCheckoutOptions): boolean {
  return isRetailerHost(ctx, host) || (options.startUrl !== undefined && hostOf(options.startUrl) === host);
}

/** Frames that may receive card data: the checkout page's own host, the store's domain, known payment processors. */
function cardFrameFilter(ctx: TaskContext, pageHost: string): (origin: string) => boolean {
  return (origin) => {
    const host = hostOf(origin);
    return host === pageHost || isRetailerHost(ctx, host) || PAYMENT_FRAME_HOSTS.test(host);
  };
}

function toFillAddress(address: Address): FillAddress {
  const phone = digitsOnly(address.phone);
  return {
    firstName: address.firstName,
    lastName: address.lastName,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    state: address.state,
    stateName: US_STATE_NAMES[address.state as keyof typeof US_STATE_NAMES] ?? address.state,
    zip: address.zip,
    phone: phone.length === 11 && phone.startsWith('1') ? phone.slice(1) : phone,
  };
}

/** The profile's stored card, or null if it has none. Pauses when the card has expired. */
function usableCard(ctx: TaskContext): StoredCard | null {
  const card = ctx.card();
  if (!card) return null;
  if (cardExpired(card.expMonth, card.expYear)) {
    throw new PauseError(
      'needs_review',
      `The stored card ending in ${card.number.slice(-4)} on profile "${ctx.profile.name}" expired ${formatExpiry(card.expMonth, card.expYear)}. Update it in Profiles, then press Start.`,
    );
  }
  return card;
}

/**
 * Fills the checkout page's empty address fields from the profile and, in 'full' or 'cvv' mode,
 * the stored card. Nothing is filled unless the page is on the store's own checkout host.
 */
async function fillCheckoutForms(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions, mode: CardMode): Promise<FillReport> {
  const pageHost = hostOf(page.url());
  if (!onCheckoutHost(ctx, pageHost, options)) return emptyFillReport();
  const card = mode === 'none' ? null : usableCard(ctx);
  const { profile } = ctx;
  const request: FillRequest = {
    shipping: mode === 'cvv' ? null : toFillAddress(profile.shipping),
    billing: mode === 'cvv' ? null : toFillAddress(profile.billingSameAsShipping ? profile.shipping : profile.billing),
    card: card
      ? { number: card.number, holder: card.holder, expMonth: card.expMonth, expYear: card.expYear, cvv: card.cvv, cvvOnly: mode === 'cvv' }
      : null,
    separateBilling: card !== null && mode === 'full' && !profile.billingSameAsShipping,
    defaultSection: 'shipping',
  };
  return page.fillForms(request, cardFrameFilter(ctx, pageHost));
}

/** Why the stored card could not be entered, or null when every card field took its value. */
export function cardFillProblem(report: FillReport, mode: 'full' | 'cvv'): string | null {
  if (mode === 'full' && !report.seen.number) return 'no card number field was found';
  if (mode === 'cvv' && !report.seen.cvv) return 'no security code field was found';
  const parts = mode === 'full' ? (['number', 'exp', 'cvv', 'name'] as const) : (['cvv'] as const);
  for (const part of parts) {
    if (report.seen[part] && !report.done[part]) return `the ${CARD_PART_LABELS[part]} field did not take the value`;
  }
  return null;
}

/**
 * Clicks the button that saves a form the app just filled, never the place-order button.
 * A card dialog in its own frame (Amazon's, for one) is saved from inside that frame first.
 */
async function submitFilledForm(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions, kind: 'card' | 'address'): Promise<boolean> {
  const exclude = options.placeOrderText;
  const attempts: Array<() => Promise<{ clicked: boolean; label: string }>> = [];
  if (kind === 'card') {
    const allow = cardFrameFilter(ctx, hostOf(page.url()));
    for (const text of [SAVE_FORM_TEXT, options.confirmPaymentText]) attempts.push(() => page.clickInChildFrames({ text, exclude }, allow));
    attempts.push(() => page.click({ text: options.confirmPaymentText, exclude }));
  }
  for (const text of [options.continueText, SAVE_FORM_TEXT]) {
    if (text) attempts.push(() => page.click({ text, exclude }));
  }
  for (const attempt of attempts) {
    const clicked = await attempt();
    if (!clicked.clicked) continue;
    ctx.log(`Checkout: ${clicked.label || 'continue'}`);
    await page.settle(ctx.signal);
    return true;
  }
  return false;
}

/**
 * One checkout step: fills empty address fields and, when the store shows a card form and the
 * profile has a stored card, the card. Saves what it filled. True when it moved the page on.
 */
async function fillStep(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions, state: CheckoutState): Promise<boolean> {
  const label = RETAILERS[ctx.task.retailer].name;
  const entry = await page.cardEntryVisible();
  const card = entry ? usableCard(ctx) : null;
  const mode: CardMode = !entry || !card ? 'none' : entry === 'card' ? 'full' : 'cvv';
  const report = await fillCheckoutForms(ctx, page, options, mode);
  const addressFields = report.shippingFields + report.billingFields;
  if (addressFields > 0) ctx.log(`Filled ${addressFields} address field(s) from profile "${ctx.profile.name}"`);
  if (mode !== 'none' && card) {
    const problem = cardFillProblem(report, mode);
    if (problem) {
      throw new PauseError('needs_review', `Could not enter the stored card on ${label}'s payment form (${problem}). Open the window to enter it yourself, then press Start.`, true);
    }
    state.cardTyped = true;
    ctx.log(mode === 'full' ? `Typed the stored card ending in ${card.number.slice(-4)} into the payment form` : 'Entered the stored card’s security code');
    // A security code goes with the place-order click, so there is nothing to save for it.
    if (mode === 'full') return submitFilledForm(ctx, page, options, 'card');
  }
  return addressFields > 0 ? submitFilledForm(ctx, page, options, 'address') : false;
}

/** Opens the store's new-card form (if it is not showing) and types the stored card into it. */
async function enterStoredCard(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions, card: StoredCard): Promise<boolean> {
  const label = RETAILERS[ctx.task.retailer].name;
  if ((await page.cardEntryVisible()) !== 'card') {
    const text = options.addCardText ?? ADD_CARD_TEXT;
    let opened = (await page.click({ within: options.paymentSectionText, text })).clicked || (await page.click({ text })).clicked;
    if (!opened && (await page.click({ within: options.paymentSectionText, text: options.changePaymentText })).clicked) {
      await page.settle(ctx.signal, 800, 8000);
      opened = (await page.click({ text })).clicked;
    }
    if (!opened) {
      ctx.log(`No "add a card" option found on ${label}'s checkout page`, 'warn');
      return false;
    }
    await page.settle(ctx.signal, 800, 8000);
    await page.waitFor(async () => (await page.cardEntryVisible()) === 'card', { timeoutMs: 8000, signal: ctx.signal });
  }
  const report = await fillCheckoutForms(ctx, page, options, 'full');
  const problem = cardFillProblem(report, 'full');
  if (problem) {
    throw new PauseError('needs_review', `Could not enter the stored card on ${label}'s payment form (${problem}). Open the window to enter it yourself, then press Start.`, true);
  }
  ctx.log(`Typed the stored card ending in ${card.number.slice(-4)} into ${label}'s payment form`);
  await submitFilledForm(ctx, page, options, 'card');
  return true;
}

/** The pause for a store that wants card details when the profile has no stored card. */
function cardEntryPause(ctx: TaskContext, entry: 'card' | 'cvv'): PauseError {
  const label = RETAILERS[ctx.task.retailer].name;
  if (entry === 'card') {
    return new PauseError(
      'cvv_required',
      `${label} is asking for a card number, so no saved card ending in ${ctx.profile.cardLast4} is usable on this account. Add a stored card to profile "${ctx.profile.name}" so the app can enter it, save the card on your ${label} account, or finish in the window.`,
      true,
    );
  }
  return new PauseError(
    'cvv_required',
    `${label} is asking for the card's security code. Add a stored card to profile "${ctx.profile.name}" so the app can enter it, or open the window and finish there.`,
    true,
  );
}

/**
 * On the review page: a store asking for card details gets the stored card (or just its
 * security code). Without a stored card the task pauses for the user.
 */
async function handleCardEntry(ctx: TaskContext, page: BrowserPage, options: BrowserCheckoutOptions, text: string, state: CheckoutState): Promise<void> {
  const entry = await page.cardEntryVisible();
  if (!entry && !looksLikeCvvPrompt(text)) return;
  const card = usableCard(ctx);
  if (!card) throw cardEntryPause(ctx, entry ?? 'cvv');
  const mode = entry === 'card' ? 'full' : 'cvv';
  const report = await fillCheckoutForms(ctx, page, options, mode);
  const problem = cardFillProblem(report, mode);
  if (problem) {
    const label = RETAILERS[ctx.task.retailer].name;
    throw new PauseError('needs_review', `${label} is asking for card details and the stored card could not be entered (${problem}). Open the window to finish.`, true);
  }
  state.cardTyped = true;
  ctx.log(mode === 'full' ? `Typed the stored card ending in ${card.number.slice(-4)} into the payment form` : 'Entered the stored card’s security code');
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

const SIGN_IN_URL = /sign-?in|log-?in|\/ap\/signin|identity\/(?:global\/)?signin|account\/login/i;

/** True when the window was sent to a sign-in page. */
export function isSignInPage(snapshot: PageSnapshot): boolean {
  return SIGN_IN_URL.test(snapshot.url) && /sign in|log in|password/i.test(snapshot.text);
}

/**
 * Verifies card, address and subtotal on the review page. Pauses (never buys) when unsure.
 * The card is the saved one ending in the profile's last 4; if the account has none and the
 * profile has a stored card, that card is typed into the store's own payment form.
 */
export async function verifyReviewPage(
  ctx: TaskContext,
  page: BrowserPage,
  options: BrowserCheckoutOptions,
  state: CheckoutState = { cardTyped: false },
): Promise<{ snapshot: PageSnapshot; subtotal: number | null }> {
  const label = RETAILERS[ctx.task.retailer].name;
  const { profile, task } = ctx;
  // A card typed into an inline form is not echoed back as "ending in 1234" until it is saved;
  // accept it as long as the page shows no other card.
  const cardConfirmed = (text: string) =>
    mentionsCardLast4(text, profile.cardLast4) || (state.cardTyped && !mentionsOtherCard(text, profile.cardLast4));
  let snapshot = await assertPage(page, 'Checkout');

  if (!cardConfirmed(snapshot.text)) {
    await selectSavedCard(ctx, page, options);
    snapshot = await assertPage(page, 'Checkout');
  }
  if (!cardConfirmed(snapshot.text)) {
    const card = usableCard(ctx);
    if (card && (await enterStoredCard(ctx, page, options, card))) {
      state.cardTyped = true;
      snapshot = await assertPage(page, 'Checkout');
    }
    if (!cardConfirmed(snapshot.text)) {
      throw new PauseError(
        'needs_review',
        card
          ? `Could not confirm that the card ending in ${profile.cardLast4} is the payment method on ${label}. Open the window to check the payment section.`
          : `Could not confirm that the saved card ending in ${profile.cardLast4} is selected on ${label}. Open the window to pick it, check the profile's last 4 digits, or add a stored card to the profile.`,
        true,
      );
    }
  }
  await handleCardEntry(ctx, page, options, snapshot.text, state);
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

/** Lets awaitConfirmation answer one security-code request with the stored card. */
export interface ConfirmRetry {
  options: BrowserCheckoutOptions;
  placeOrder: ClickTarget;
}

export async function awaitConfirmation(ctx: TaskContext, page: BrowserPage, confirmationUrl: RegExp, retry?: ConfirmRetry): Promise<CheckoutResult> {
  return afterSubmit(async () => {
    const deadline = Date.now() + 120_000;
    let cvvEntered = false;
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
      const entry = await page.cardEntryVisible(false);
      if (entry) {
        // Some stores ask for the security code only after "Place order" and keep the order
        // waiting for it. Answer that once with the stored card; anything else pauses.
        const card = entry === 'cvv' && retry && !cvvEntered ? ctx.card() : null;
        if (card && retry && !cardExpired(card.expMonth, card.expYear)) {
          cvvEntered = true;
          const report = await fillCheckoutForms(ctx, page, retry.options, 'cvv');
          if (!cardFillProblem(report, 'cvv') && (await page.click(retry.placeOrder)).clicked) {
            ctx.log('The store asked for the security code after "Place order": entered it and confirmed the same order');
            continue;
          }
        }
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

  const state: CheckoutState = { cardTyped: false };
  for (let step = 0; step < (options.maxSteps ?? 6); step++) {
    const snapshot = await assertPage(page, 'Checkout');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();
    if (await fillStep(ctx, page, options, state)) continue;
    if (await hasPlaceOrder()) break;
    if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    if (!options.continueText) break;
    const next = await page.click({ text: options.continueText, exclude: options.placeOrderText });
    if (!next.clicked) break;
    ctx.log(`Checkout: ${next.label}`);
    await page.settle(ctx.signal);
  }
  if (!(await hasPlaceOrder())) {
    const snapshot = await assertPage(page, 'Checkout');
    if (isSignInPage(snapshot)) throw new NeedsSignInError();
    const entry = await page.cardEntryVisible();
    if (entry && !ctx.card()) throw cardEntryPause(ctx, entry);
    if (looksOutOfStock(snapshot.text)) throw new OutOfStockError();
    throw new RetailerError(
      state.cardTyped
        ? 'Could not reach the order review page after entering the stored card (the store may have rejected it)'
        : 'Could not reach the order review page (no place-order button found)',
    );
  }

  const { subtotal } = await verifyReviewPage(ctx, page, options, state);
  if (ctx.dryRun) {
    return {
      placed: false,
      detail: `Dry run: card ending in ${ctx.profile.cardLast4}${state.cardTyped ? ' (stored card entered)' : ''}, ZIP ${ctx.profile.shipping.zip} and subtotal ${formatUsd(subtotal)} verified. Order not placed.`,
    };
  }
  ctx.beforePlaceOrder();
  ctx.status('checking_out', 'Placing order');
  const placeOrder: ClickTarget = { ...(options.placeOrderSelectors ? { selectors: options.placeOrderSelectors } : {}), text: options.placeOrderText };
  const submitted = await page.click(placeOrder);
  if (!submitted.clicked) throw new RetailerError('The place-order button could not be clicked');
  ctx.log(`Clicked "${submitted.label || 'Place order'}", waiting for confirmation`);
  return awaitConfirmation(ctx, page, options.confirmationUrl, { options, placeOrder });
}
