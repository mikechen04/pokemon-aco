import { describe, expect, it } from 'vitest';
import { classifyPage, isQueueUrl, queueProgress } from '../src/main/engine/detection';
import { AbortedError, sleep } from '../src/main/engine/errors';
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
} from '../src/main/engine/guards';
import { Semaphore } from '../src/main/engine/semaphore';
import { availabilityBuyable, decodeJwtPayload, findKey, jsonLdProducts, parseHtml } from '../src/main/retailers/html';

const bigPage = (extra: string) => `<html><body>${'<p>Lots of normal product page content.</p>'.repeat(6000)}${extra}</body></html>`;

describe('classifyPage', () => {
  it('detects CAPTCHA pages', () => {
    expect(classifyPage({ url: 'https://www.amazon.com/dp/B0X', text: '<form action="/errors/validateCaptcha">Type the characters you see in this image</form>' }).kind).toBe('captcha');
    expect(classifyPage({ url: 'https://x.com', text: 'Press & Hold to confirm you are a human' }).kind).toBe('captcha');
  });

  it('does not treat invisible reCAPTCHA scripts on normal pages as a challenge', () => {
    expect(classifyPage({ url: 'https://x.com/login', status: 200, text: bigPage('<script src="https://www.google.com/recaptcha/api.js"></script>') }).kind).toBe('ok');
    expect(classifyPage({ url: 'https://x.com/login', status: 403, text: '<div class="g-recaptcha"></div>' }).kind).toBe('captcha');
  });

  it('detects bot challenges and blocks', () => {
    expect(classifyPage({ url: 'https://x.com', status: 403, text: '<html><title>Just a moment...</title><div id="challenge-platform"></div></html>' }).kind).toBe('bot_challenge');
    const akamai = classifyPage({ url: 'https://x.com', status: 403, text: 'Access Denied. You don\'t have permission to access this. Reference #18.6d2f1002.1700000000.1234abcd' });
    expect(akamai.kind).toBe('blocked');
    expect(akamai.detail).toMatch(/Akamai/);
    expect(classifyPage({ url: 'https://x.com', status: 200, text: bigPage('<script src="/_Incapsula_Resource?x"></script>') }).kind).toBe('ok');
  });

  it('detects waiting rooms by URL or by wording on small pages only', () => {
    expect(isQueueUrl('https://pokemon.queue-it.net/?c=pokemon&e=drop')).toBe(true);
    expect(isQueueUrl('https://www.pokemoncenter.com/product/1-2/x')).toBe(false);
    expect(classifyPage({ url: 'https://www.pokemoncenter.com/', text: '<h1>You are now in line.</h1><p>Your number in line: 1,234</p>' }).kind).toBe('queue');
    expect(classifyPage({ url: 'https://www.pokemoncenter.com/', text: bigPage('<footer>We may use a virtual queue during busy launches.</footer>') }).kind).toBe('ok');
    expect(classifyPage({ url: 'https://x.com', text: 'Welcome to the waiting room', source: 'dom' }).kind).toBe('queue');
    expect(classifyPage({ url: 'https://x.com', text: 'x'.repeat(7000) + ' waiting room', source: 'dom' }).kind).toBe('ok');
  });

  it('reports rate limits with Retry-After', () => {
    const d = classifyPage({ url: 'https://x.com', status: 429, text: 'slow down', headers: { 'retry-after': '30' } });
    expect(d.kind).toBe('rate_limited');
    expect(d.retryAfterMs).toBe(30_000);
  });

  it('reads queue progress text', () => {
    expect(queueProgress('Your number in line: 1,234. Your estimated wait time is 12 minutes.')).toBe('position 1,234, est. wait 12 minutes');
    expect(queueProgress('nothing here')).toBeNull();
  });
});

describe('checkout guards', () => {
  const address = { firstName: 'Ash', lastName: 'Ketchum', address1: '123 Main Street', address2: 'Apt 4', city: 'Santa Cruz', state: 'CA', zip: '95060', phone: '' };

  it('matches the ship-to address despite abbreviations and case', () => {
    expect(addressMatches('Ship to: ASH KETCHUM 123 MAIN ST APT 4 SANTA CRUZ, CA 95060-1234', address)).toBe(true);
    expect(addressMatches('Ship to: 123 Main St, Santa Cruz, CA 95062', address)).toBe(false);
    expect(addressMatches('Ship to: 124 Main St, Santa Cruz, CA 95060', address)).toBe(false);
  });

  it('finds the saved card by its last 4', () => {
    expect(mentionsCardLast4('Visa ending in 4242', '4242')).toBe(true);
    expect(mentionsCardLast4('Mastercard •••• 4242', '4242')).toBe(true);
    expect(mentionsCardLast4('Card ****4242', '4242')).toBe(true);
    expect(mentionsCardLast4('Visa x4242', '4242')).toBe(true);
    expect(mentionsCardLast4('Visa ending in 1881', '4242')).toBe(false);
    expect(mentionsCardLast4('Order 4242 items', '4242')).toBe(false);
  });

  it('reads subtotals and totals', () => {
    expect(extractSubtotal('Subtotal (2 items)\n$99.98\nTax $8.00')).toBe(99.98);
    expect(extractSubtotal('Items: $49.99 Shipping & handling: $0.00')).toBe(49.99);
    expect(extractSubtotal('Item(s) Subtotal: $1,049.00')).toBe(1049);
    expect(extractOrderTotal('Subtotal $10.00 Order total: $12.34')).toBe(12.34);
    expect(checkSubtotal(99.98, 49.99, 2).ok).toBe(true);
    expect(checkSubtotal(100.0, 49.99, 2).ok).toBe(false);
    expect(checkSubtotal(null, 49.99, 1).ok).toBe(false);
  });

  it('recognizes confirmations, declines, stock-outs and CVV prompts', () => {
    expect(looksLikeConfirmation('https://x.com/thankyou', 'Thank you for your order! Order number: 1234567')).toBe(true);
    expect(looksLikeConfirmation('https://x.com/checkout', 'Review your order')).toBe(false);
    expect(extractOrderNumber('Order #: 112-1234567-1234567')).toBe('112-1234567-1234567');
    expect(extractOrderNumber('order number is pending')).toBeNull();
    expect(looksDeclined('Your card was declined. Please use a different payment method.')).toBe(true);
    expect(looksOutOfStock('Sorry, this item is sold out')).toBe(true);
    expect(looksLikeCvvPrompt('Please re-enter your security code to continue')).toBe(true);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots to waiters in order', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let third = false;
    const p3 = sem.acquire().then((r) => {
      third = true;
      return r;
    });
    await sleep(10);
    expect(third).toBe(false);
    expect(sem.waiting).toBe(1);
    r1();
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(sem.inUse).toBe(2);
    r2();
    r3();
    expect(sem.inUse).toBe(0);
  });

  it('removes aborted waiters and grows when the limit is raised', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AbortedError);
    expect(sem.waiting).toBe(0);
    const p2 = sem.acquire();
    sem.setLimit(2);
    const r2 = await p2;
    r1();
    r2();
    expect(sem.inUse).toBe(0);
  });
});

describe('html helpers', () => {
  it('reads schema.org Product data, including @graph and nested offers', () => {
    const root = parseHtml(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"ETB","sku":"290-1","image":["https://img/1.png"],"offers":{"@type":"AggregateOffer","offers":[{"price":"49.99","availability":"https://schema.org/InStock"}]}}]}</script>`);
    expect(jsonLdProducts(root)).toEqual([{ name: 'ETB', image: 'https://img/1.png', sku: '290-1', price: 49.99, availability: 'InStock' }]);
    expect(availabilityBuyable('InStock')).toBe(true);
    expect(availabilityBuyable('OutOfStock')).toBe(false);
    expect(availabilityBuyable('Weird')).toBeUndefined();
  });

  it('finds keys anywhere in JSON and decodes JWT payloads', () => {
    expect(findKey({ a: [{ b: { availability_status: 'IN_STOCK' } }] }, 'availability_status')).toEqual(['IN_STOCK']);
    const token = `x.${Buffer.from(JSON.stringify({ sut: 'R' })).toString('base64url')}.y`;
    expect(decodeJwtPayload(token)).toEqual({ sut: 'R' });
    expect(decodeJwtPayload('garbage')).toBeNull();
  });
});
