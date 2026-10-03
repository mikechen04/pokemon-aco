// Checkout form filling, run inside a store's page. Same rules as pageScripts.ts: each page
// function is serialized with Function.prototype.toString, so it must be self-contained (no
// imports, no outer variables), and it only uses ordinary DOM input events in that window.
//
// Fields are recognized from their autocomplete attribute first (the standard way browsers
// autofill), then from name/id/placeholder/label hints. Address fields are filled only when
// empty. Card fields are filled only when the caller passes a card, which it does only on the
// store's own checkout page and inside known payment-processor frames.

export interface FillAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  /** Two-letter code, e.g. "CA". */
  state: string;
  /** Full name, e.g. "California", for dropdowns that list names. */
  stateName: string;
  zip: string;
  /** Digits only, without a leading country code. */
  phone: string;
}

export interface FillCard {
  number: string;
  holder: string;
  expMonth: number;
  expYear: number;
  cvv: string;
  /** Only fill the security code (a saved card is selected and the store asks to confirm it). */
  cvvOnly: boolean;
}

export interface FillRequest {
  /** Fills empty shipping-address fields. */
  shipping: FillAddress | null;
  /** Fills empty billing-address fields (the ones next to a card form). */
  billing: FillAddress | null;
  card: FillCard | null;
  /** Untick "billing address same as shipping" so a separate billing address can be entered. */
  separateBilling: boolean;
  /** Address fields with no billing/shipping hint: shipping in the page, billing in a payment frame. */
  defaultSection: 'shipping' | 'billing';
}

export interface CardParts {
  number: boolean;
  exp: boolean;
  cvv: boolean;
  name: boolean;
}

export interface FillReport {
  /** Visible card fields that were found. */
  seen: CardParts;
  /** Card fields that now hold the stored card's values. */
  done: CardParts;
  shippingFields: number;
  billingFields: number;
  /** "Same as shipping" was unticked; the billing form appears a moment later. */
  toggledBilling: boolean;
}

export function emptyFillReport(): FillReport {
  return {
    seen: { number: false, exp: false, cvv: false, name: false },
    done: { number: false, exp: false, cvv: false, name: false },
    shippingFields: 0,
    billingFields: 0,
    toggledBilling: false,
  };
}

/** Combines the reports from the page and its payment frames. */
export function mergeFillReports(reports: FillReport[]): FillReport {
  const merged = emptyFillReport();
  for (const r of reports) {
    for (const part of ['number', 'exp', 'cvv', 'name'] as const) {
      merged.seen[part] ||= r.seen[part];
      merged.done[part] ||= r.done[part];
    }
    merged.shippingFields += r.shippingFields;
    merged.billingFields += r.billingFields;
    merged.toggledBilling ||= r.toggledBilling;
  }
  return merged;
}

export function pageFillForms(req: FillRequest): FillReport {
  type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  type Kind =
    | 'cc-number'
    | 'cc-name'
    | 'cc-exp'
    | 'cc-exp-month'
    | 'cc-exp-year'
    | 'cc-csc'
    | 'given-name'
    | 'family-name'
    | 'name'
    | 'address-line1'
    | 'address-line2'
    | 'city'
    | 'state'
    | 'postal-code'
    | 'tel';

  const report: FillReport = {
    seen: { number: false, exp: false, cvv: false, name: false },
    done: { number: false, exp: false, cvv: false, name: false },
    shippingFields: 0,
    billingFields: 0,
    toggledBilling: false,
  };
  const lower = (v: string | null | undefined): string => (v ?? '').toLowerCase();
  const digits = (v: string): string => v.replace(/\D/g, '');
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelText = (el: HTMLElement): string => {
    const labels = (el as HTMLInputElement).labels;
    let text = labels ? Array.from(labels).map((l) => l.innerText).join(' ') : '';
    for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)) {
      if (id) text += ` ${document.getElementById(id)?.innerText ?? ''}`;
    }
    return text.slice(0, 160);
  };
  const hintOf = (el: HTMLElement): string =>
    lower(
      [
        el.getAttribute('name'),
        el.id,
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-test'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-fieldtype'),
        el.getAttribute('data-automation-id'),
        labelText(el),
      ].join(' '),
    );

  // Never touch these, whatever else they look like.
  const SKIP = /search|promo|coupon|discount|voucher|gift|loyalty|reward|member|redcard|store ?card|captcha|one[-_ ]?time|\botp\b|password|e-?mail|company|business|country|birth|\bdob\b/;
  const AUTOCOMPLETE: Record<string, Kind> = {
    'cc-number': 'cc-number',
    'cc-name': 'cc-name',
    'cc-exp': 'cc-exp',
    'cc-exp-month': 'cc-exp-month',
    'cc-exp-year': 'cc-exp-year',
    'cc-csc': 'cc-csc',
    'given-name': 'given-name',
    'family-name': 'family-name',
    name: 'name',
    'address-line1': 'address-line1',
    'street-address': 'address-line1',
    'address-line2': 'address-line2',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'postal-code',
    tel: 'tel',
    'tel-national': 'tel',
  };
  const CARD_NUMBER = /(?:card|cc|credit)[-_ ]?(?:card)?[-_ ]?(?:number|num\b|no\b)|cardnumber|encryptedcardnumber/;

  const kindOf = (el: Field): Kind | null => {
    const tokens = lower(el.getAttribute('autocomplete')).split(/\s+/).filter(Boolean);
    const token = tokens[tokens.length - 1];
    const hint = hintOf(el);
    if (SKIP.test(hint)) return null;
    if (token && AUTOCOMPLETE[token]) return AUTOCOMPLETE[token];
    if (!hint.trim()) return null;
    if (/card ?holder|holder ?name|name ?on ?(?:the )?card|cc[-_ ]?name|nameoncard|accountholdername/.test(hint)) return 'cc-name';
    if (CARD_NUMBER.test(hint)) return 'cc-number';
    if (/cvv|cvc|\bcsc\b|\bcid\b|security ?code|securitycode|card ?verification|encryptedsecuritycode/.test(hint)) return 'cc-csc';
    const isSelect = el instanceof HTMLSelectElement;
    if (/exp[\w-]*month|month[\w-]*exp|(?:cc|card)[-_ ]?month|expirationdate_month/.test(hint) || (isSelect && /month/.test(hint))) return 'cc-exp-month';
    if (/exp[\w-]*year|year[\w-]*exp|(?:cc|card)[-_ ]?year|expirationdate_year/.test(hint) || (isSelect && /year/.test(hint))) return 'cc-exp-year';
    if (/\bexp(?:iry|iration)?\b|exp(?:iry|iration)?[-_ ]?date|expirationdate|expirydate|mm ?\/ ?yy|valid ?thru/.test(hint)) return 'cc-exp';
    if (/first[-_ ]?name|\bfname\b|given/.test(hint)) return 'given-name';
    if (/last[-_ ]?name|\blname\b|surname|family/.test(hint)) return 'family-name';
    if (/address[-_ ]?(?:line)?[-_ ]?2|addr(?:ess)?2|\bapt\b|apartment|suite|\bunit\b|line ?2/.test(hint)) return 'address-line2';
    if (/address[-_ ]?(?:line)?[-_ ]?1|addr(?:ess)?1|street|line ?1|\baddress\b/.test(hint)) return 'address-line1';
    if (/city|town|locality/.test(hint)) return 'city';
    if (/state(?!ment)|province|region/.test(hint)) return 'state';
    if (/zip|postal|post ?code/.test(hint)) return 'postal-code';
    if (/phone|mobile|\btel\b|telephone/.test(hint)) return 'tel';
    if (/full ?name|\bname\b/.test(hint)) return 'name';
    return null;
  };
  const isCardKind = (k: Kind | null): boolean => k !== null && k.startsWith('cc-');

  const PAYMENT_FRAME = /cybersource|microform|adyen|checkoutshopper|braintree|stripe|tokenex|spreedly|paymentech|worldpay/i;
  const holdsCard = (root: Element): boolean =>
    Array.from(root.querySelectorAll('input, select')).some((f) => isCardKind(kindOf(f as Field))) ||
    Array.from(root.querySelectorAll('iframe')).some((f) => PAYMENT_FRAME.test(f.src));
  const sectionOf = (el: Field): 'shipping' | 'billing' => {
    const ac = lower(el.getAttribute('autocomplete'));
    if (/\bbilling\b/.test(ac)) return 'billing';
    if (/\bshipping\b/.test(ac)) return 'shipping';
    const hint = hintOf(el);
    if (/bill/.test(hint)) return 'billing';
    if (/ship|deliver/.test(hint)) return 'shipping';
    for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 10; p = p.parentElement, depth++) {
      const attrs = lower(
        `${p.id} ${typeof p.className === 'string' ? p.className : ''} ${p.getAttribute('aria-label') ?? ''} ${p.getAttribute('data-test') ?? ''} ${p.getAttribute('data-testid') ?? ''}`,
      );
      if (/bill/.test(attrs)) return 'billing';
      if (/ship|deliver/.test(attrs)) return 'shipping';
      const heading = Array.from(p.children).find((c) => /^(?:H[1-6]|LEGEND)$/.test(c.tagName));
      const headingText = lower(heading?.textContent);
      if (/billing/.test(headingText)) return 'billing';
      if (/shipping|delivery|ship to/.test(headingText)) return 'shipping';
      if ((p.tagName === 'FORM' || p.tagName === 'FIELDSET') && holdsCard(p)) return 'billing';
    }
    return req.defaultSection;
  };

  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const setNative = (el: Field, value: string) => {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  };
  // Sets the value the way a framework-controlled input (React, Vue, Angular) notices it.
  const typeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string, ok: (current: string) => boolean): boolean => {
    el.focus();
    setNative(el, value);
    fire(el, 'input');
    fire(el, 'change');
    if (!ok(el.value)) {
      // Masked inputs can reject a programmatic value: insert it as typed text instead.
      try {
        el.focus();
        el.select();
        document.execCommand('insertText', false, value);
        fire(el, 'change');
      } catch {
        // leave it; the caller sees the field as not filled
      }
    }
    el.blur();
    return ok(el.value);
  };
  const chooseOption = (sel: HTMLSelectElement, candidates: string[], loose?: RegExp): boolean => {
    const options = Array.from(sel.options).filter((o) => !o.disabled);
    const wanted = candidates.map((c) => c.toLowerCase());
    let option =
      options.find((o) => wanted.includes(o.value.trim().toLowerCase())) ??
      options.find((o) => wanted.includes(o.text.trim().toLowerCase()));
    if (!option && loose) option = options.find((o) => loose.test(o.text.trim()) || loose.test(o.value.trim()));
    if (!option) return false;
    if (sel.value !== option.value) {
      sel.focus();
      setNative(sel, option.value);
      fire(sel, 'input');
      fire(sel, 'change');
      sel.blur();
    }
    return true;
  };
  const selectIsEmpty = (sel: HTMLSelectElement): boolean =>
    sel.value === '' || (sel.selectedIndex <= 0 && /select|choose|--|^\s*$/i.test(sel.options[0]?.text ?? ''));

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  // The expiry can be one "MM/YY" field or a month and a year field; null = not on the page.
  const expiry: { combined: boolean | null; month: boolean | null; year: boolean | null } = { combined: null, month: null, year: null };
  const fillCardField = (el: Field, kind: Kind, card: FillCard): void => {
    const mm = String(card.expMonth).padStart(2, '0');
    const yyyy = String(card.expYear);
    const yy = yyyy.slice(-2);
    if (kind === 'cc-number') {
      report.seen.number = true;
      if (card.cvvOnly || el instanceof HTMLSelectElement) return;
      const ok = (v: string) => digits(v) === card.number || (/[•*●x]/i.test(v) && digits(v).endsWith(card.number.slice(-4)) && digits(v).length <= 4);
      report.done.number = ok(el.value) || typeValue(el, card.number, ok);
    } else if (kind === 'cc-csc') {
      report.seen.cvv = true;
      if (el instanceof HTMLSelectElement) return;
      const ok = (v: string) => v === card.cvv || (v.length === card.cvv.length && /^[•*●]+$/.test(v));
      report.done.cvv = ok(el.value) || typeValue(el, card.cvv, ok);
    } else if (kind === 'cc-name') {
      report.seen.name = true;
      if (card.cvvOnly || el instanceof HTMLSelectElement) return;
      report.done.name = el.value.trim() !== '' || typeValue(el, card.holder, (v) => v.trim() !== '');
    } else if (kind === 'cc-exp') {
      report.seen.exp = true;
      if (card.cvvOnly || el instanceof HTMLSelectElement) return;
      const placeholder = el.getAttribute('placeholder') ?? '';
      const long = /yyyy/i.test(placeholder) || (!/yy/i.test(placeholder) && (el as HTMLInputElement).maxLength >= 7);
      const value = long ? `${mm}/${yyyy}` : `${mm}/${yy}`;
      const ok = (v: string) => digits(v) === `${mm}${yy}` || digits(v) === `${mm}${yyyy}`;
      expiry.combined = (expiry.combined ?? true) && (ok(el.value) || typeValue(el, value, ok));
    } else if (kind === 'cc-exp-month') {
      report.seen.exp = true;
      if (card.cvvOnly) return;
      const name = MONTHS[card.expMonth - 1] ?? '';
      const ok =
        el instanceof HTMLSelectElement
          ? chooseOption(el, [mm, String(card.expMonth), name, name.slice(0, 3)], new RegExp(`^0?${card.expMonth}\\b`))
          : Number(el.value) === card.expMonth || typeValue(el, mm, (v) => Number(v) === card.expMonth);
      expiry.month = (expiry.month ?? true) && ok;
    } else if (kind === 'cc-exp-year') {
      report.seen.exp = true;
      if (card.cvvOnly) return;
      const short = !(el instanceof HTMLSelectElement) && ((el as HTMLInputElement).maxLength === 2 || /^yy$/i.test(el.getAttribute('placeholder') ?? ''));
      const ok =
        el instanceof HTMLSelectElement
          ? chooseOption(el, [yyyy, yy], new RegExp(`\\b${yyyy}\\b`))
          : el.value === (short ? yy : yyyy) || typeValue(el, short ? yy : yyyy, (v) => v === yy || v === yyyy);
      expiry.year = (expiry.year ?? true) && ok;
    }
  };

  const fillAddressField = (el: Field, kind: Kind, address: FillAddress): boolean => {
    if (el instanceof HTMLSelectElement) {
      if (!selectIsEmpty(el)) return false;
      if (kind === 'state') return chooseOption(el, [address.state, address.stateName]);
      return false;
    }
    if (el.value.trim() !== '') return false;
    let value = '';
    if (kind === 'given-name') value = address.firstName;
    else if (kind === 'family-name') value = address.lastName;
    else if (kind === 'name') value = `${address.firstName} ${address.lastName}`.trim();
    else if (kind === 'address-line1') value = address.address1;
    else if (kind === 'address-line2') value = address.address2;
    else if (kind === 'city') value = address.city;
    else if (kind === 'state') value = address.state;
    else if (kind === 'postal-code') value = address.zip;
    else if (kind === 'tel') value = address.phone;
    if (!value) return false;
    const ok = kind === 'tel' ? (v: string) => digits(v).endsWith(value) : (v: string) => v.trim() !== '';
    return typeValue(el, value, ok);
  };

  if (req.separateBilling) {
    for (const box of Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]) {
      if (!box.checked) continue;
      const text = lower(`${labelText(box)} ${box.name} ${box.id} ${box.getAttribute('aria-label') ?? ''}`);
      if (!/same as (?:my |the )?(?:shipping|delivery)|billing[\w ]*same|same[\w ]*billing|use (?:my |the )?(?:shipping|delivery) address/.test(text)) continue;
      // Styled checkboxes are often hidden behind their label: click whichever is showing.
      const target = visible(box) ? box : Array.from(box.labels ?? []).find(visible);
      if (target) {
        target.click();
        report.toggledBilling = true;
      }
    }
  }

  const fields = (Array.from(document.querySelectorAll('input, select, textarea')) as Field[]).filter((el) => {
    if (el instanceof HTMLInputElement && !/^(?:text|tel|number|password)$/i.test(el.type)) return false;
    if (el.disabled || (el as HTMLInputElement).readOnly) return false;
    return visible(el);
  });
  for (const el of fields) {
    const kind = kindOf(el);
    if (!kind) continue;
    if (el instanceof HTMLInputElement && el.type === 'password' && kind !== 'cc-csc') continue;
    if (isCardKind(kind)) {
      if (req.card) fillCardField(el, kind, req.card);
      continue;
    }
    const section = sectionOf(el);
    const address = section === 'billing' ? req.billing : req.shipping;
    if (!address || !fillAddressField(el, kind, address)) continue;
    if (section === 'billing') report.billingFields++;
    else report.shippingFields++;
  }
  report.done.exp = expiry.combined === true || (expiry.month === true && expiry.year === true);
  return report;
}
