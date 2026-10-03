// Loose validation for records loaded from disk. Anything malformed is dropped rather
// than crashing the app; fields that are missing get safe defaults.
import { parseProductInput } from '../../shared/retailers';
import {
  RETAILER_IDS,
  type Address,
  type CardBrand,
  type CardSummary,
  type Profile,
  type RetailerId,
  type Task,
  type TaskResult,
} from '../../shared/types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function isRetailerId(v: unknown): v is RetailerId {
  return typeof v === 'string' && (RETAILER_IDS as readonly string[]).includes(v);
}

function normalizeAddress(raw: unknown): Address {
  const a = isObj(raw) ? raw : {};
  return {
    firstName: str(a.firstName),
    lastName: str(a.lastName),
    address1: str(a.address1),
    address2: str(a.address2),
    city: str(a.city),
    state: str(a.state),
    zip: str(a.zip),
    phone: str(a.phone),
  };
}

const CARD_BRANDS: readonly CardBrand[] = ['visa', 'mastercard', 'amex', 'discover', 'other'];

function normalizeCardSummary(raw: unknown): CardSummary | null {
  if (!isObj(raw)) return null;
  const last4 = str(raw.last4);
  if (!/^\d{4}$/.test(last4)) return null;
  return {
    brand: CARD_BRANDS.includes(raw.brand as CardBrand) ? (raw.brand as CardBrand) : 'other',
    last4,
    expMonth: num(raw.expMonth, 1),
    expYear: num(raw.expYear, 2000),
    holder: str(raw.holder),
    updatedAt: num(raw.updatedAt, Date.now()),
  };
}

export function normalizeProfile(raw: unknown): Profile | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const last4 = str(raw.cardLast4);
  return {
    id: raw.id,
    createdAt: num(raw.createdAt, Date.now()),
    name: raw.name,
    shipping: normalizeAddress(raw.shipping),
    billingSameAsShipping: raw.billingSameAsShipping !== false,
    billing: normalizeAddress(raw.billing),
    cardLast4: /^\d{4}$/.test(last4) ? last4 : '',
    cardLabel: str(raw.cardLabel),
    card: normalizeCardSummary(raw.card),
  };
}

function normalizeResult(raw: unknown): TaskResult | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.state !== 'checked_out' && raw.state !== 'failed') return undefined;
  return {
    state: raw.state,
    message: str(raw.message),
    at: num(raw.at, Date.now()),
    ...(typeof raw.orderNumber === 'string' ? { orderNumber: raw.orderNumber } : {}),
  };
}

export function normalizeTask(raw: unknown): Task | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !isRetailerId(raw.retailer)) return null;
  const mode = raw.mode === 'keyword' ? 'keyword' : 'url';
  const input = str(raw.input);
  if (!input) return null;
  let productId: string | undefined;
  if (mode === 'url') {
    const parsed = parseProductInput(raw.retailer, input);
    if (!parsed.ok) return null;
    productId = parsed.product.productId;
  }
  const lastResult = normalizeResult(raw.lastResult);
  return {
    id: raw.id,
    createdAt: num(raw.createdAt, Date.now()),
    retailer: raw.retailer,
    mode,
    input,
    ...(productId ? { productId } : {}),
    ...(typeof raw.catalogEntryId === 'string' ? { catalogEntryId: raw.catalogEntryId } : {}),
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    profileId: str(raw.profileId),
    accountId: str(raw.accountId),
    quantity: Math.max(1, Math.round(num(raw.quantity, 1))),
    maxPrice: Math.max(0.01, num(raw.maxPrice, 0.01)),
    ...(typeof raw.groupId === 'string' && raw.groupId ? { groupId: raw.groupId } : {}),
    ...(typeof raw.groupName === 'string' && raw.groupName ? { groupName: raw.groupName } : {}),
    ...(typeof raw.groupGoal === 'number' && raw.groupGoal >= 1 ? { groupGoal: Math.round(raw.groupGoal) } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}
