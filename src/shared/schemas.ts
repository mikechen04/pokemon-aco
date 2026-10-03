// Validation for everything that crosses from the UI into the main process,
// plus catalog files imported from disk.
import { z } from 'zod';
import { isValidLogin } from './accountLines';
import { cardBrand, cardExpired, cvvLength, digitsOnly, luhnValid } from './cards';
import { DISCORD_WEBHOOK_PATTERN, LIMITS, US_STATES } from './constants';
import { parseKeywords } from './keywords';
import { parseProxyList } from './proxies';
import { parseProductInput } from './retailers';
import { RETAILER_IDS, type CatalogEntry, type RetailerId } from './types';

/**
 * True when the text contains something shaped like a payment card number
 * (13-19 digits, optionally grouped with spaces or dashes, passing the Luhn check).
 * Free-text fields reject these: a card number belongs only in a profile's stored card.
 */
export function looksLikeCardNumber(text: string): boolean {
  const candidates = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return candidates.some((c) => {
    const digits = c.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

const NO_CARD = 'Do not enter card numbers here. A full card goes only in a profile’s stored card section.';
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .refine((v) => !looksLikeCardNumber(v), NO_CARD);
const requiredText = (label: string, max: number) => safeText(max).pipe(z.string().min(1, `${label} is required`));

export const retailerIdSchema = z.enum(RETAILER_IDS);

export const addressSchema = z.object({
  firstName: requiredText('First name', 60),
  lastName: requiredText('Last name', 60),
  address1: requiredText('Address', 120),
  address2: safeText(120),
  city: requiredText('City', 60),
  state: z.enum(US_STATES, 'Pick a US state'),
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/, 'ZIP must be 5 digits (or ZIP+4)'),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9()+\-.\s]{7,20}$/, 'Enter a valid phone number'),
});

export const profileInputSchema = z.object({
  name: requiredText('Profile name', 60),
  shipping: addressSchema,
  billingSameAsShipping: z.boolean(),
  billing: addressSchema,
  cardLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Enter exactly the last 4 digits of the saved card'),
  cardLabel: safeText(40),
});

const thisYear = new Date().getFullYear();

/** A full card for a profile. Checked here and again in the main process before it is encrypted. */
export const cardInputSchema = z
  .object({
    holder: requiredText('Name on card', 80),
    number: z
      .string()
      .max(40)
      .transform(digitsOnly)
      .pipe(
        z
          .string()
          .regex(/^\d{13,19}$/, 'Card number must be 13 to 19 digits')
          .refine(luhnValid, 'That card number is not valid. Check for a typo.'),
      ),
    expMonth: z.number().int().min(1, 'Pick the expiry month').max(12, 'Pick the expiry month'),
    expYear: z.number().int().min(thisYear - 1, 'Pick the expiry year').max(thisYear + 25, 'Pick the expiry year'),
    cvv: z.string().trim().regex(/^\d{3,4}$/, 'Security code must be 3 or 4 digits'),
  })
  .superRefine((card, ctx) => {
    if (cardExpired(card.expMonth, card.expYear)) ctx.addIssue({ code: 'custom', message: 'This card has expired', path: ['expYear'] });
    const brand = cardBrand(card.number);
    if (brand !== 'other' && card.cvv.length !== cvvLength(brand)) {
      ctx.addIssue({ code: 'custom', message: `The security code for this card is ${cvvLength(brand)} digits`, path: ['cvv'] });
    }
  });

export const accountInputSchema = z.object({
  retailer: retailerIdSchema,
  label: requiredText('Label', 60),
  email: z
    .string()
    .trim()
    .refine(isValidLogin, 'Enter the account’s email address (or phone number for Amazon)'),
  password: z.string().max(256).optional(),
  twoFactorNote: safeText(200).optional(),
  profileId: z.string().max(100).optional(),
});

export const bulkAccountSchema = z.object({
  retailer: retailerIdSchema,
  text: z.string().min(1, 'Paste at least one account').max(500_000),
  profileId: z.string().max(100).optional(),
  labelPrefix: safeText(40).optional(),
});

export const taskInputSchema = z
  .object({
    retailer: retailerIdSchema,
    mode: z.enum(['url', 'keyword']),
    input: z.string().trim().min(1, 'Enter a product URL, SKU or keywords').max(2000),
    catalogEntryId: z.string().max(100).optional(),
    label: safeText(120).optional(),
    profileId: z.string().min(1, 'Pick a profile'),
    accountId: z.string().min(1, 'Pick an account'),
    quantity: z.number().int().min(1, 'Quantity must be at least 1').max(LIMITS.maxQuantityPerTask.max),
    maxPrice: z
      .number()
      .min(LIMITS.maxPrice.min, 'Set a max price per item')
      .max(LIMITS.maxPrice.max),
  })
  .superRefine((task, ctx) => {
    if (task.mode === 'url') {
      const parsed = parseProductInput(task.retailer, task.input);
      if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error, path: ['input'] });
    } else if (parseKeywords(task.input).positive.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Add at least one keyword that must match', path: ['input'] });
    }
  });

export const taskCreateSchema = z.object({
  input: taskInputSchema,
  accountIds: z.array(z.string().min(1).max(100)).min(1, 'Pick at least one account').max(500),
  useAccountProfiles: z.boolean(),
  copies: z.number().int().min(1).max(20),
  groupName: safeText(60),
  groupGoal: z.number().int().min(1).max(1000).nullable(),
});

const intIn = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);

export const settingsPatchSchema = z
  .object({
    pollIntervalMs: intIn(LIMITS.pollIntervalMs),
    requestTimeoutMs: intIn(LIMITS.requestTimeoutMs),
    maxConcurrency: intIn(LIMITS.maxConcurrency),
    maxQuantityPerTask: intIn(LIMITS.maxQuantityPerTask),
    maxConsecutiveFailures: intIn(LIMITS.maxConsecutiveFailures),
    sessionKeepAliveMinutes: intIn(LIMITS.sessionKeepAliveMinutes),
    dryRun: z.boolean(),
    killSwitch: z.boolean(),
    proxies: z
      .string()
      .max(200_000)
      .refine(
        (v) => parseProxyList(v).invalid.length === 0,
        'Some proxy lines are invalid. Use host:port, host:port:user:pass or http://user:pass@host:port',
      ),
    webhookUrl: z
      .string()
      .trim()
      .refine((v) => v === '' || DISCORD_WEBHOOK_PATTERN.test(v), 'Must be a Discord webhook URL'),
    desktopNotifications: z.boolean(),
    notifyOn: z
      .object({
        inStock: z.boolean(),
        queue: z.boolean(),
        carted: z.boolean(),
        checkedOut: z.boolean(),
        paused: z.boolean(),
        failed: z.boolean(),
      })
      .partial(),
    blockImagesInBackground: z.boolean(),
    showAutomationWindows: z.boolean(),
    bestBuyApiKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{0,64}$/, 'Best Buy API keys are letters and digits only'),
    amazonSoldByAmazonOnly: z.boolean(),
    autoUpdate: z.boolean(),
    catalogFeedUrl: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => /^https:\/\/[^\s]+$/i.test(v), 'The catalog feed URL must start with https://'),
    catalogAutoSync: z.boolean(),
  })
  .partial()
  .strict();

const catalogRefSchema = z.object({
  url: z.string().trim().max(2000).default(''),
  sku: z.string().trim().max(100).default(''),
});

const emptyRef = { url: '', sku: '' };

const catalogRetailersSchema = z
  .object({
    target: catalogRefSchema.default(emptyRef),
    bestbuy: catalogRefSchema.default(emptyRef),
    amazon: catalogRefSchema.default(emptyRef),
    pokemoncenter: catalogRefSchema.default(emptyRef),
  })
  .default({ target: emptyRef, bestbuy: emptyRef, amazon: emptyRef, pokemoncenter: emptyRef });

const price = z.number().min(0).max(100_000);
const change = z.number().min(-1).max(1000);

const catalogMarketSchema = z.object({
  price: price.nullable().default(null),
  low: price.nullable().default(null),
  change7d: change.nullable().default(null),
  change30d: change.nullable().default(null),
  updatedAt: z.string().max(40).default(''),
});

const catalogEditableFields = {
  name: requiredText('Name', 160),
  category: safeText(60).default('Other'),
  set: safeText(80).default(''),
  tags: z.array(safeText(40)).max(30).default([]),
  imageUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https:\/\//i.test(v), 'Image URL must start with https://')
    .default(''),
  msrp: price.nullable().default(null),
  msrpEstimated: z.boolean().default(false),
  notes: safeText(1000).default(''),
  retailers: catalogRetailersSchema,
};

const catalogFeedEntryShape = {
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes for ids'),
  ...catalogEditableFields,
  releaseDate: z
    .string()
    .trim()
    .regex(/^(?:\d{4}-\d{2}-\d{2})?$/, 'Release date must look like 2026-11-06')
    .default(''),
  tcgplayerId: z.number().int().positive().nullable().default(null),
  tcgplayerUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https:\/\/(?:www\.)?tcgplayer\.com\//i.test(v), 'TCGplayer links must be on tcgplayer.com')
    .default(''),
  market: catalogMarketSchema.nullable().default(null),
  score: z.number().min(-1000).max(1000).nullable().default(null),
};

export const catalogEntrySchema = z.object({
  ...catalogFeedEntryShape,
  origin: z.enum(['user', 'feed']).default('user'),
  feedBase: z.object(catalogEditableFields).optional(),
});

export const catalogFileSchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string().max(64).default(''),
  feed: z
    .object({
      url: z.string().max(2000),
      syncedAt: z.string().max(64),
      generatedAt: z.string().max(64),
      source: z.string().max(500).default(''),
    })
    .optional(),
  dismissed: z.array(z.string().max(100)).max(5000).default([]),
  entries: z.array(catalogEntrySchema).max(5000),
});

/** catalog/feed.json as published by the catalog-feed workflow. */
export const catalogFeedSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1).max(64),
  source: z.string().max(500).default(''),
  entries: z.array(z.object(catalogFeedEntryShape)).max(3000),
});

/** Checks that each filled-in retailer URL/SKU actually parses for that retailer. */
export function catalogEntryProblems(entry: CatalogEntry): string[] {
  const problems: string[] = [];
  for (const id of RETAILER_IDS) {
    const ref = entry.retailers[id];
    const value = ref.url || ref.sku;
    if (!value) continue;
    const parsed = parseProductInput(id as RetailerId, value);
    if (!parsed.ok) problems.push(`${id}: ${parsed.error}`);
  }
  return problems;
}

/** First validation problem as a short human sentence. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  const path = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
