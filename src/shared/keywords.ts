// Keyword expressions, in the style used by most retail bots:
//   "pokemon, elite trainer box, -sleeves"   (comma separated, phrases allowed)
//   "pokemon etb -sleeves"                   (space separated words)
// A leading "+" (or nothing) means the term must appear; "-" means it must not.

export interface KeywordQuery {
  positive: string[];
  negative: string[];
}

/** Lowercase, strip accents (Pokémon -> pokemon) and collapse punctuation to spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function parseKeywords(raw: string): KeywordQuery {
  const parts = raw.includes(',') ? raw.split(',') : raw.split(/\s+/);
  const query: KeywordQuery = { positive: [], negative: [] };
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const negative = trimmed.startsWith('-');
    const term = normalizeText(trimmed.replace(/^[+-]+/, ''));
    if (!term) continue;
    (negative ? query.negative : query.positive).push(term);
  }
  return query;
}

/** Whole-word containment, so "etb" does not match inside "fetbox". */
function containsTerm(haystack: string, term: string): boolean {
  return ` ${haystack} `.includes(` ${term} `);
}

export function matchesKeywords(title: string, query: KeywordQuery): boolean {
  if (query.positive.length === 0) return false;
  const text = normalizeText(title);
  return query.positive.every((t) => containsTerm(text, t)) && !query.negative.some((t) => containsTerm(text, t));
}

/** The text sent to a retailer's search: the positive terms only. */
export function searchText(query: KeywordQuery): string {
  return query.positive.join(' ');
}

export function describeKeywords(query: KeywordQuery): string {
  const pos = query.positive.map((t) => `+${t}`);
  const neg = query.negative.map((t) => `-${t}`);
  return [...pos, ...neg].join(' ');
}
