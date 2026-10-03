import { describe, expect, it } from 'vitest';
import { isValidLogin, parseAccountLines } from '../src/shared/accountLines';
import { describeKeywords, matchesKeywords, parseKeywords } from '../src/shared/keywords';
import { formatUsd, parsePrice } from '../src/shared/money';
import { describeProxy, parseProxyLine, parseProxyList, proxyRules } from '../src/shared/proxies';

describe('keywords', () => {
  it('parses comma phrases and space words with +/- prefixes', () => {
    expect(parseKeywords('pokemon, elite trainer box, -sleeves')).toEqual({ positive: ['pokemon', 'elite trainer box'], negative: ['sleeves'] });
    expect(parseKeywords('+pokemon etb -binder')).toEqual({ positive: ['pokemon', 'etb'], negative: ['binder'] });
  });

  it('matches whole words, ignores accents and respects negatives', () => {
    const q = parseKeywords('pokemon, elite trainer box, -sleeves');
    expect(matchesKeywords('Pokémon TCG: Elite Trainer Box (30th Celebration)', q)).toBe(true);
    expect(matchesKeywords('Pokémon Elite Trainer Box Card Sleeves', q)).toBe(false);
    expect(matchesKeywords('Pokemon Booster Bundle', q)).toBe(false);
    expect(matchesKeywords('Fetbox pokemon', parseKeywords('pokemon etb'))).toBe(false);
    expect(matchesKeywords('anything', parseKeywords('-only-negative'))).toBe(false);
    expect(describeKeywords(q)).toBe('+pokemon +elite trainer box -sleeves');
  });
});

describe('money', () => {
  it('parses common price formats', () => {
    expect(parsePrice('$1,234.56')).toBe(1234.56);
    expect(parsePrice('USD 49.99')).toBe(49.99);
    expect(parsePrice('$5.9')).toBe(5.9);
    expect(parsePrice('49')).toBe(49);
    expect(parsePrice('Price unavailable')).toBeNull();
    expect(parsePrice(12.5)).toBe(12.5);
    expect(formatUsd(59.99)).toBe('$59.99');
    expect(formatUsd(undefined)).toBe('—');
  });
});

describe('proxies', () => {
  it('accepts the supported formats', () => {
    expect(parseProxyLine('203.0.113.10:8080')).toEqual({ host: '203.0.113.10', port: 8080 });
    expect(parseProxyLine('proxy.example.com:3128:user:p:ss')).toEqual({ host: 'proxy.example.com', port: 3128, username: 'user', password: 'p:ss' });
    expect(parseProxyLine('http://user:secret@proxy.example.com:8000')).toEqual({ host: 'proxy.example.com', port: 8000, username: 'user', password: 'secret' });
    expect(parseProxyLine('user:secret@proxy.example.com:8000')).toMatchObject({ username: 'user', password: 'secret' });
  });

  it('rejects non-HTTP schemes and malformed lines', () => {
    expect(parseProxyLine('socks5://proxy.example.com:1080')).toBeNull();
    expect(parseProxyLine('proxy.example.com')).toBeNull();
    expect(parseProxyLine('proxy.example.com:99999')).toBeNull();
    expect(parseProxyLine('host:80:onlyuser')).toBeNull();
    const list = parseProxyList('# comment\n1.2.3.4:80\n\nbad\n');
    expect(list.proxies).toHaveLength(1);
    expect(list.invalid).toEqual(['bad']);
  });

  it('never exposes credentials in rules or descriptions', () => {
    const proxy = parseProxyLine('http://user:secret@proxy.example.com:8000');
    expect(proxy).not.toBeNull();
    if (!proxy) return;
    expect(proxyRules(proxy)).toBe('http://proxy.example.com:8000');
    expect(describeProxy(proxy)).toBe('proxy.example.com:8000 (auth)');
  });
});

describe('bulk account lines', () => {
  it('splits on the first separator so passwords may contain separators', () => {
    const result = parseAccountLines('a@example.com:pa:ss,word\nb@example.com,pw2\nc@example.com\tpw3\n# skip\n\n+1 (555) 010-0199:pw4');
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { email: 'a@example.com', password: 'pa:ss,word' },
      { email: 'b@example.com', password: 'pw2' },
      { email: 'c@example.com', password: 'pw3' },
      { email: '+1 (555) 010-0199', password: 'pw4' },
    ]);
  });

  it('counts duplicates and reports bad lines without echoing them', () => {
    const result = parseAccountLines('a@example.com:one\nA@Example.com:two\nnot an email secretpassword');
    expect(result.entries).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^Line 3:/);
    expect(result.errors[0]).not.toContain('secretpassword');
  });

  it('validates logins', () => {
    expect(isValidLogin('ash@example.com')).toBe(true);
    expect(isValidLogin('555-010-0199')).toBe(true);
    expect(isValidLogin('three-no-at')).toBe(false);
    expect(isValidLogin('a@b')).toBe(false);
  });
});
