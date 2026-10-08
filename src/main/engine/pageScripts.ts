// Functions that run inside a retailer page (in an isolated JavaScript world, so the page
// cannot see or tamper with them). They are serialized with Function.prototype.toString,
// so each one must be completely self-contained: no imports, no outer variables.
// Interaction is ordinary DOM clicks and input events inside that hidden window only;
// nothing here touches the operating system mouse or keyboard.

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  html: string;
  visibleCaptcha: string | null;
}

export function pageSnapshot(): PageSnapshot {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 40 && r.height > 40 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const captchaFrame = Array.from(document.querySelectorAll('iframe')).find(
    (f) =>
      /recaptcha\/(?:api2|enterprise)\/(?:bframe|anchor)|hcaptcha\.com|captcha-delivery\.com|arkoselabs|funcaptcha|challenges\.cloudflare\.com/i.test(
        f.src,
      ) && visible(f),
  );
  const pxCaptcha = document.querySelector('#px-captcha');
  let visibleCaptcha: string | null = null;
  if (captchaFrame) visibleCaptcha = new URL(captchaFrame.src, location.href).hostname;
  else if (pxCaptcha && visible(pxCaptcha)) visibleCaptcha = 'PerimeterX';
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 120_000),
    html: document.documentElement.outerHTML.slice(0, 400_000),
    visibleCaptcha,
  };
}

export interface ClickTarget {
  /** CSS selectors, tried in order. */
  selectors?: string[];
  /** Regex source matched against a clickable element's visible label. */
  text?: string;
  /** Regex source: only look inside the smallest container whose text matches this. */
  within?: string;
  /** Regex source: never click an element whose label matches this (e.g. "Place order"). */
  exclude?: string;
}

export function pageClick(target: ClickTarget): { clicked: boolean; label: string } {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const enabled = (el: Element): boolean =>
    !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[disabled]');
  const labelOf = (el: Element): string =>
    ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim();

  let root: ParentNode = document;
  if (target.within) {
    // Find a short text node matching the heading (e.g. "Payment"), then widen to the
    // nearest ancestor that also contains something clickable.
    const re = new RegExp(target.within, 'i');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let container: Element | null = null;
    for (let node = walker.nextNode(); node && !container; node = walker.nextNode()) {
      const value = (node.nodeValue ?? '').trim();
      if (!value || value.length > 200 || !re.test(value) || !node.parentElement || !visible(node.parentElement)) continue;
      let el: Element | null = node.parentElement;
      for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
        if (el.querySelector('button, a, input[type="submit"], [role="button"]')) {
          container = el;
          break;
        }
      }
    }
    if (!container) return { clicked: false, label: '' };
    root = container;
  }

  const candidates: Element[] = [];
  for (const selector of target.selectors ?? []) {
    try {
      candidates.push(...Array.from(root.querySelectorAll(selector)));
    } catch {
      // invalid selector from an override file: skip it
    }
  }
  if (target.text) {
    const re = new RegExp(target.text, 'i');
    const clickable = root.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"]');
    for (const el of Array.from(clickable)) if (re.test(labelOf(el))) candidates.push(el);
  }
  const excluded = target.exclude ? new RegExp(target.exclude, 'i') : null;
  const el = candidates.find((c) => visible(c) && enabled(c) && !(excluded && excluded.test(labelOf(c)))) as HTMLElement | undefined;
  if (!el) return { clicked: false, label: '' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { clicked: true, label: labelOf(el).slice(0, 80) };
}

/** Types a value into the first visible matching input in a way React/Vue/Angular forms notice. */
export function pageFill(selectors: string[], value: string): boolean {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  let input: HTMLInputElement | null = null;
  for (const selector of selectors) {
    try {
      const found = Array.from(document.querySelectorAll(selector)).find(visible);
      if (found) {
        input = found as HTMLInputElement;
        break;
      }
    } catch {
      // ignore invalid selectors
    }
  }
  if (!input) return false;
  input.focus();
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
  return true;
}

export function pageExists(selectors: string[]): boolean {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  for (const selector of selectors) {
    try {
      if (Array.from(document.querySelectorAll(selector)).some(visible)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function pageReadText(selectors: string[]): string | null {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      const text = el ? ((el as HTMLElement).innerText || el.textContent || '').trim() : '';
      if (text) return text;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Detects a payment form waiting for card data: an empty card-number or security-code field,
 * or (with `includeFrames`) a payment processor's secure card iframe. Gift card, loyalty and
 * promo fields are ignored. Only emptiness is checked; field values are never read out.
 */
export function pageCardEntryVisible(includeFrames: boolean): 'cvv' | 'card' | null {
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  };
  const hint = (input: HTMLInputElement): string =>
    `${input.name} ${input.id} ${input.autocomplete} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`;
  const inputs = Array.from(document.querySelectorAll('input')).filter(
    (i) => shown(i) && !i.disabled && !i.readOnly && i.value.trim() === '' && !/gift|loyalty|reward|redcard|promo|coupon/i.test(hint(i)),
  );
  if (inputs.some((i) => /cc-number|card\s*number|cardnumber|credit-?card-?number/i.test(hint(i)))) return 'card';
  if (includeFrames) {
    const secureFrame = Array.from(document.querySelectorAll('iframe')).some(
      (f) => shown(f) && /cybersource|flex\.|microform|adyen|checkoutshopper|braintree|hosted-?fields|stripe|paypal\.com\/sdk/i.test(f.src),
    );
    if (secureFrame) return 'card';
  }
  if (inputs.some((i) => /cvv|cvc|cc-csc|security\s*code|securitycode|card\s*verification/i.test(hint(i)))) return 'cvv';
  return null;
}

export interface CardSelection {
  found: boolean;
  selected: boolean;
  label: string;
}

/**
 * Selects the saved card whose label shows the given last 4 digits ("ending in 1234",
 * "•••• 1234"). Clicks its radio button or row. Never reads or types card data.
 */
export function pageSelectCard(last4: string): CardSelection {
  const pattern = new RegExp(
    `(?:ending\\s*(?:in|with)?|ends\\s*(?:in|with)|[•*·.xX]{2,}|\\bx)\\s*[-:]?\\s*${last4}(?!\\d)`,
    'i',
  );
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== 'hidden';
  };
  // Start from text nodes containing the 4 digits; "ending in <b>1234</b>" spans nodes,
  // so test a few ancestors' text against the full pattern.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let labelEl: HTMLElement | null = null;
  for (let node = walker.nextNode(); node && !labelEl; node = walker.nextNode()) {
    if (!(node.nodeValue ?? '').includes(last4)) continue;
    let el: HTMLElement | null = node.parentElement;
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      const text = el.innerText || '';
      if (text.length < 400 && pattern.test(text) && visible(el)) {
        labelEl = el;
        break;
      }
    }
  }
  if (!labelEl) return { found: false, selected: false, label: '' };
  const row =
    (labelEl.closest('label, li, [role="radio"], [role="option"], [role="button"], button') as HTMLElement | null) ?? labelEl;
  const label = (row.innerText || labelEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  let radio = row.querySelector('input[type="radio"]') as HTMLInputElement | null;
  for (let el: HTMLElement | null = row, depth = 0; !radio && el && depth < 3; depth++, el = el.parentElement) {
    radio = el.querySelector('input[type="radio"]') as HTMLInputElement | null;
  }
  if (radio?.checked || row.getAttribute('aria-checked') === 'true' || row.getAttribute('aria-selected') === 'true') {
    return { found: true, selected: true, label };
  }
  row.scrollIntoView({ block: 'center' });
  (radio ?? row).click();
  return { found: true, selected: true, label };
}

/** Collects the submit fields of a form (for replaying a retailer's own form over HTTP). */
export function pageFormFields(formSelector: string): { action: string; fields: Array<[string, string]> } | null {
  const form = document.querySelector(formSelector) as HTMLFormElement | null;
  if (!form) return null;
  const fields: Array<[string, string]> = [];
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') fields.push([name, value]);
  return { action: form.action, fields };
}

/** Picks an option in the first visible matching <select> (e.g. a quantity dropdown). */
export function pageSelectValue(selectors: string[], value: string): boolean {
  for (const selector of selectors) {
    let select: HTMLSelectElement | null = null;
    try {
      select = Array.from(document.querySelectorAll(selector)).find((el) => {
        const r = el.getBoundingClientRect();
        return el instanceof HTMLSelectElement && r.width > 0 && r.height > 0;
      }) as HTMLSelectElement | null;
    } catch {
      continue;
    }
    if (!select) continue;
    const option = Array.from(select.options).find((o) => o.value === value || o.text.trim() === value);
    if (!option) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(select, option.value);
    else select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/** Visible text inside a same-origin iframe (e.g. a retailer's own checkout panel). */
export function pageFrameText(frameSelector: string): string {
  const frame = document.querySelector(frameSelector) as HTMLIFrameElement | null;
  try {
    return (frame?.contentDocument?.body?.innerText ?? '').slice(0, 60_000);
  } catch {
    return '';
  }
}

/** Clicks the first matching element inside a same-origin iframe. */
export function pageFrameClick(frameSelector: string, selectors: string[]): boolean {
  const frame = document.querySelector(frameSelector) as HTMLIFrameElement | null;
  const doc = frame?.contentDocument;
  if (!doc) return false;
  for (const selector of selectors) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (el && !(el as HTMLButtonElement).disabled) {
      el.click();
      return true;
    }
  }
  return false;
}

export interface SignupValues {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
}

/**
 * Fills a store's sign-up form like a password manager: email, password (and its confirm
 * box), first and last name (or one full-name box) and phone. Only empty, visible fields are
 * touched, so whatever the user typed stays. Returns which kinds of field were filled.
 */
export function pageFillSignup(values: SignupValues): string[] {
  const visible = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const describe = (input: HTMLInputElement): string =>
    [input.name, input.id, input.getAttribute('autocomplete'), input.placeholder, input.getAttribute('aria-label'), input.labels?.[0]?.innerText]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const kindOf = (input: HTMLInputElement): keyof SignupValues | 'fullName' | null => {
    const type = (input.type || 'text').toLowerCase();
    const text = describe(input);
    const auto = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (type === 'password') return 'password';
    if (!['text', 'email', 'tel', ''].includes(type)) return null;
    if (type === 'email' || auto === 'email' || auto === 'username' || /e-?mail|user ?name|username|login/.test(text)) return 'email';
    // Not ours: search boxes, address parts, verification codes and the like.
    if (/search|zip|postal|address|city|code|otp|captcha|birth|promo|coupon/.test(text)) return null;
    if (auto === 'given-name' || /first.?name|fname|given/.test(text)) return 'firstName';
    if (auto === 'family-name' || /last.?name|lname|surname|family/.test(text)) return 'lastName';
    if (type === 'tel' || auto.startsWith('tel') || /phone|mobile|\btel\b/.test(text)) return 'phone';
    if (auto === 'name' || /full.?name|customer.?name|your name|^name$|\bname\b/.test(text)) return 'fullName';
    return null;
  };
  const filled: string[] = [];
  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => visible(i) && !i.disabled && !i.readOnly);
  for (const input of inputs) {
    const kind = kindOf(input);
    if (!kind || input.value) continue;
    const value =
      kind === 'fullName'
        ? `${values.firstName} ${values.lastName}`.trim()
        : kind === 'phone'
          ? values.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
          : values[kind];
    if (!value) continue;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    filled.push(kind);
  }
  return filled;
}
