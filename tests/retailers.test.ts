import { describe, expect, it } from 'vitest';
import { bestBuySkuFromHtml, detectRetailer, isRetailerUrl, parseProductInput, titleFromUrl } from '../src/shared/retailers';

function productId(retailer: Parameters<typeof parseProductInput>[0], input: string): string | null {
  const parsed = parseProductInput(retailer, input);
  return parsed.ok ? parsed.product.productId : null;
}

describe('detectRetailer', () => {
  it('recognizes each store by host', () => {
    expect(detectRetailer('https://www.target.com/p/x/-/A-12345678')).toBe('target');
    expect(detectRetailer('https://www.bestbuy.com/site/x/6606082.p?skuId=6606082')).toBe('bestbuy');
    expect(detectRetailer('https://www.amazon.com/dp/B0ABCDEFGH')).toBe('amazon');
    expect(detectRetailer('https://www.pokemoncenter.com/product/290-85584/x')).toBe('pokemoncenter');
  });

  it('ignores look-alike and unsupported hosts', () => {
    expect(detectRetailer('https://target.com.evil.example/p/A-12345678')).toBeNull();
    expect(detectRetailer('https://www.amazon.ca/dp/B0ABCDEFGH')).toBeNull();
    expect(detectRetailer('not a url')).toBeNull();
    expect(isRetailerUrl('https://example.com')).toBe(false);
  });
});

describe('parseProductInput', () => {
  it('reads a Target TCIN from URLs and bare ids', () => {
    expect(productId('target', 'https://www.target.com/p/pokemon-etb/-/A-93954435?preselect=1#lnk')).toBe('93954435');
    expect(productId('target', 'https://www.target.com/p/pokemon/-/A-11111111?preselect=22222222')).toBe('22222222');
    expect(productId('target', '93954435')).toBe('93954435');
    // Real 2026 listing with a 10-digit TCIN.
    expect(productId('target', 'https://www.target.com/p/pok-233-mon-trading-card-game-30th-celebration-elite-trainer-box/-/A-1010892076')).toBe('1010892076');
    expect(productId('pokemoncenter', 'https://www.pokemoncenter.com/product/10-10447-111/pokemon-tcg-30th-celebration-pokemon-center-elite-trainer-box')).toBe('10-10447-111');
    expect(productId('amazon', 'https://www.amazon.com/dp/B0H78BB9TY')).toBe('B0H78BB9TY');
    expect(productId('target', 'https://www.target.com/c/toys')).toBeNull();
  });

  it('reads a Best Buy SKU from the query, path, or a bare id', () => {
    expect(productId('bestbuy', 'https://www.bestbuy.com/site/pokemon-etb/6606082.p?skuId=6606082')).toBe('6606082');
    expect(productId('bestbuy', 'https://www.bestbuy.com/site/pokemon-etb/6606082.p')).toBe('6606082');
    expect(productId('bestbuy', 'https://www.bestbuy.com/product/pokemon/ABC123/sku/6606082')).toBe('6606082');
    expect(productId('bestbuy', '6606082')).toBe('6606082');
    // 2026 links: 8-digit SKUs, and product-code links with no SKU at all.
    expect(productId('bestbuy', 'https://www.bestbuy.com/product/pokemon-trading-card-game-30th-celebration-elite-trainer-box/JJG2TL8XCJ/sku/13089535')).toBe('13089535');
    expect(productId('bestbuy', 'https://www.bestbuy.com/product/pokemon-trading-card-game-30th-celebration-booster-bundle/JJG2TL8X2V')).toBe('JJG2TL8X2V');
    expect(productId('bestbuy', '13089535')).toBe('13089535');
    expect(parseProductInput('bestbuy', 'https://www.bestbuy.com/product/pokemon-trading-card-game/SEARCHPAGE').ok).toBe(false);
  });

  it('reads an Amazon ASIN and normalizes the URL', () => {
    const parsed = parseProductInput('amazon', 'https://www.amazon.com/Pokemon-Trading-Card-Game/dp/b0abcdefgh/ref=sr_1_1?tag=x');
    expect(parsed.ok && parsed.product.productId).toBe('B0ABCDEFGH');
    expect(parsed.ok && parsed.product.url).toBe('https://www.amazon.com/dp/B0ABCDEFGH');
    expect(productId('amazon', 'B0ABCDEFGH')).toBe('B0ABCDEFGH');
    expect(productId('amazon', 'NOTANASIN1')).toBeNull();
  });

  it('requires a full URL for Pokémon Center', () => {
    expect(productId('pokemoncenter', 'https://www.pokemoncenter.com/product/290-85584/pokemon-tcg-etb')).toBe('290-85584');
    expect(productId('pokemoncenter', 'https://www.pokemoncenter.com/product/10-10027-101/plush')).toBe('10-10027-101');
    expect(productId('pokemoncenter', '290-85584')).toBeNull();
  });

  it('tells the user which store a URL belongs to', () => {
    const parsed = parseProductInput('target', 'https://www.amazon.com/dp/B0ABCDEFGH');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/Amazon URL/);
  });
});

describe('titleFromUrl', () => {
  it('builds a readable title from the URL slug', () => {
    expect(titleFromUrl('https://www.target.com/p/pokemon-tcg-elite-trainer-box/-/A-12345678')).toBe('Pokemon Tcg Elite Trainer Box');
    expect(titleFromUrl('https://www.pokemoncenter.com/product/290-85584/pokemon-tcg-booster-bundle')).toBe('Pokemon Tcg Booster Bundle');
    expect(titleFromUrl('https://www.amazon.com/dp/B0ABCDEFGH')).toBeNull();
    expect(titleFromUrl('https://www.target.com/p/%E0%A4%A-bad-escape/-/A-1')).toBeTypeOf('string');
  });
});

describe('bestBuySkuFromHtml', () => {
  it('prefers the canonical link, then the SKU the page mentions most', () => {
    expect(bestBuySkuFromHtml('<link rel="canonical" href="https://www.bestbuy.com/product/x/JJG2TL8X2V/sku/13089536">')).toBe('13089536');
    const page = `<script>{"skuId":"13089536","price":26.94}</script><div data-sku-id="6606082"></div>
      <script>window.__x={\\"skuId\\":\\"13089536\\"}</script><script>{"sku":"13089536"}</script>`;
    expect(bestBuySkuFromHtml(page)).toBe('13089536');
    expect(bestBuySkuFromHtml('<html>no sku here</html>')).toBeNull();
  });
});
