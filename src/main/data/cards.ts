// Stored payment cards, one per profile (opt-in, e.g. virtual cards). Kept in their own file,
// encrypted with the OS key store (DPAPI on Windows); the app refuses to write it otherwise.
// The number and security code never leave the main process: the UI only gets a summary,
// and they are typed only into the payment form on a store's own checkout page.
import { cardBrand, digitsOnly } from '../../shared/cards';
import type { CardInput, CardSummary } from '../../shared/types';
import { JsonStore } from '../core/fileStore';
import { paths } from '../core/paths';
import { forgetSecret, registerSecret } from '../core/redact';
import { encryptionStatus } from '../core/secrets';

export interface StoredCard {
  profileId: string;
  holder: string;
  number: string;
  expMonth: number;
  expYear: number;
  cvv: string;
  updatedAt: number;
}

interface CardsFile {
  version: 1;
  cards: StoredCard[];
}

function normalizeFile(raw: unknown): CardsFile {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { cards?: unknown }).cards)
    ? (raw as { cards: unknown[] }).cards
    : [];
  const cards: StoredCard[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const number = typeof c.number === 'string' ? digitsOnly(c.number) : '';
    if (typeof c.profileId !== 'string' || !/^\d{13,19}$/.test(number)) continue;
    if (typeof c.expMonth !== 'number' || typeof c.expYear !== 'number') continue;
    cards.push({
      profileId: c.profileId,
      holder: typeof c.holder === 'string' ? c.holder : '',
      number,
      expMonth: c.expMonth,
      expYear: c.expYear,
      cvv: typeof c.cvv === 'string' ? c.cvv : '',
      updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
    });
  }
  return { version: 1, cards };
}

export function summarizeCard(card: StoredCard): CardSummary {
  return {
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expMonth: card.expMonth,
    expYear: card.expYear,
    holder: card.holder,
    updatedAt: card.updatedAt,
  };
}

export class CardsRepo {
  private readonly store: JsonStore<CardsFile>;

  constructor(onError: (message: string) => void) {
    this.store = new JsonStore<CardsFile>({
      path: paths.dataFile('cards.json'),
      defaults: () => ({ version: 1, cards: [] }),
      encrypt: true,
      requireEncryption: true,
      normalize: normalizeFile,
      onError,
    });
    // Log redaction masks these numbers anywhere they could appear.
    for (const card of this.store.get().cards) registerSecret(card.number);
  }

  private assertEncryption(): void {
    const status = encryptionStatus();
    if (!status.available) throw new Error('Windows DPAPI / OS encryption is not available, so a card cannot be stored safely.');
    // The weak Linux fallback is only accepted when a developer opted into it explicitly.
    if (!status.strong && process.env.ACO_ALLOW_WEAK_ENCRYPTION !== '1') {
      throw new Error(`OS encryption on this system is weak (${status.backend}), so a card cannot be stored safely.`);
    }
  }

  get(profileId: string): StoredCard | undefined {
    return this.store.get().cards.find((c) => c.profileId === profileId);
  }

  /** Stores (or replaces) the profile's card. The input must already be validated. */
  set(profileId: string, input: CardInput): CardSummary {
    this.assertEncryption();
    const card: StoredCard = {
      profileId,
      holder: input.holder.trim(),
      number: digitsOnly(input.number),
      expMonth: input.expMonth,
      expYear: input.expYear,
      cvv: input.cvv.trim(),
      updatedAt: Date.now(),
    };
    const previous = this.get(profileId);
    registerSecret(card.number);
    this.store.update((file) => ({ ...file, cards: [...file.cards.filter((c) => c.profileId !== profileId), card] }));
    if (previous) this.forgetUnused(previous.number);
    return summarizeCard(card);
  }

  remove(profileId: string): boolean {
    const existing = this.get(profileId);
    if (!existing) return false;
    this.store.update((file) => ({ ...file, cards: file.cards.filter((c) => c.profileId !== profileId) }));
    this.forgetUnused(existing.number);
    return true;
  }

  /** Stops masking a number once no profile stores it (the same card can be on several profiles). */
  private forgetUnused(number: string): void {
    if (!this.store.get().cards.some((c) => c.number === number)) forgetSecret(number);
  }

  /** Deletes cards whose profile no longer exists. */
  removeOrphans(profileIds: Set<string>): number {
    const orphans = this.store.get().cards.filter((c) => !profileIds.has(c.profileId));
    for (const card of orphans) this.remove(card.profileId);
    return orphans.length;
  }

  flush(): void {
    this.store.flushSync();
  }
}
