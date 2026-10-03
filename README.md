# Pokemon ACO

A Windows desktop app that watches Pokémon TCG products at **Target, Best Buy, Amazon and Pokémon Center** and checks out automatically when they come in stock, using each store's normal purchase flow. It pays with the card saved on your store account, or with a card you store in the app (for example a virtual card).

Built with Electron + TypeScript + React. It packages as a normal Windows installer (`.exe`) you can share.

> Not affiliated with or endorsed by The Pokémon Company, Nintendo, Target, Best Buy, Amazon or Pokémon Center. Using automation may be against a store's terms of use; that is your call. Store purchase limits (per customer or household) still apply.

---

## What it does

- **Tasks** from a product URL, a SKU/TCIN/ASIN, keywords (`pokemon, elite trainer box, -sleeves`) or a **catalog** entry.
- **A catalog that fills itself**: current Pokémon TCG sealed products with **TCGplayer market prices, margin over retail, 7-day trend** and store links. It is rebuilt daily on GitHub and synced by the app, and sorting by **Hottest** puts the biggest flips first.
- **Background monitoring** without touching your mouse or keyboard. Tasks on the same product share one stock check per interval.
- **Automatic checkout** the moment stock appears: add to cart, then on the store's own checkout page it verifies **card last 4, ship-to address and subtotal** before placing the order.
- **Stored cards (optional)**: save a full card (number, expiry, security code, billing address) on a profile. Fresh accounts with nothing saved still check out: the app fills the shipping form, adds the card and answers security-code prompts on the store's checkout page.
- **Multi-account**: bulk-add the store accounts you own, then one "New task" creates one task per account. They all try to check out in parallel. An optional **"stop after N orders"** limit keeps the group from over-buying.
- **Pokémon Center waiting room**: the task joins the line in its own window, waits (it never skips or reloads), and continues when the queue passes. You get a notification while the queue is what's holding it up.
- **Live updates** per task, desktop notifications and an optional **Discord webhook**.
- **Safety limits**: max price per task, max quantity (global cap), **dry run on by default**, a global **kill switch**, and **auto-stop** after repeated failures.

## What it deliberately does not do

- No CAPTCHA solving, no TLS or browser fingerprint spoofing, no user-agent changes, no anti-bot sensor generation, no queue skipping, and no switching proxies to dodge a block.
- When a store shows a **CAPTCHA, bot challenge, block or 2FA prompt**, the task **pauses** and tells you. You can open that task's window, handle it yourself, and press Start. If you finish the order by hand in that window, the app detects the confirmation page and marks the task checked out.
- Card data is **never sent anywhere except the store's own checkout page** (and the card processor's secure fields embedded in it). A full card is only stored if you add one to a profile. Without one, a store asking for card details pauses the task and you finish in the window.
- It does not create store accounts. It only uses accounts you add.

---

## Install on Windows

**Option A: download the installer (no setup).** Get `Pokemon-ACO-Setup-<version>.exe` from the repo's **Releases** page (or from any green **Actions → Windows installer** run, under Artifacts) and run it.

**Updates are automatic** from version 1.1.0 on:

- **How it checks:** the installed app looks at this repo's GitHub Releases a few seconds after it starts, then every 6 hours.
- **When it downloads:** new versions download in the background, but only while no task is running, so a download never competes with a drop.
- **When it installs:** when you quit the app, or right away with **Settings → App updates → Restart and install**. Tasks, profiles, accounts and stored cards are kept.
- **Turning it off:** switch off "Download updates automatically" in Settings to download by hand instead.
- **Older installs:** anyone on 1.0.0 has to install 1.1.0 once by hand (1.0.0 had no updater).

**Option B: build it yourself.**

1. Install **Node.js 22 LTS** from nodejs.org.
2. In the project folder:
   ```bash
   npm ci
   npm run dist:win
   ```
3. The installer is at `release/Pokemon-ACO-Setup-<version>.exe`.

The installer is not code-signed, so Windows SmartScreen will warn on first run: click **More info → Run anyway**. To sign it, give electron-builder a certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`).

## Publishing an update

Installed apps update themselves from GitHub Releases. To ship a new version:

```bash
npm version patch            # or minor / major: bumps package.json and creates the tag
git push --follow-tags       # pushes the commit and the v<version> tag
```

The **Windows installer** workflow then:

1. Checks that the tag matches `package.json`.
2. Runs the type check and tests.
3. Builds the installer.
4. Publishes a Release with `Pokemon-ACO-Setup-<version>.exe`, its `.blockmap` and `latest.yml`.

Installed apps find it within 6 hours, or on their next start.

## Run in development

```bash
npm ci
npm run dev        # UI hot-reloads; main process restarts on change
npm run typecheck  # TypeScript, main + UI
npm test           # unit tests (vitest)
npm run build      # production bundle in dist/
npm start          # run the production bundle
```

On Linux without a keyring, start with `ACO_ALLOW_WEAK_ENCRYPTION=1 npm run dev` (weak, for development only). Windows always uses DPAPI.

---

## What you need to fill in

1. **Profiles**: shipping address and the card to pay with. Either:
   - **Saved on the store account**: enter its **last 4 digits**, or
   - **Store the full card here**: number, expiry and security code (encrypted, see below). Good for virtual cards and for fresh accounts with nothing saved.
2. **Accounts**: your store logins (or **Bulk add**: one `email:password` per line). Press **Sign in** once per account to get past 2FA. That session is kept and reused.
3. **On each store account** (optional with a stored card): save the card and shipping address you want used. The app selects a saved card by its last 4. With a stored card it adds the card at checkout when the account has none.
4. **Catalog**: nothing to type. It syncs itself (see [Catalog feed](#catalog-feed-prices-margins-and-store-links)). Add a store link to any entry that lacks one with **Edit**. Sync keeps your edits.
5. **Settings (optional)**: Discord webhook URL, a free **Best Buy developer API key** (recommended for Best Buy keyword search), proxies.
6. Run a task in **dry run** first. When it reports "card, ZIP and subtotal verified", turn dry run off (sidebar toggle). With a stored card, a dry run can save the address and card on the store account (that is part of the store's checkout), but it never places the order.

## Catalog feed (prices, margins and store links)

`catalog/feed.json` is rebuilt every day by the **Catalog feed** workflow (`.github/workflows/catalog-feed.yml`, 21:17 UTC). The app downloads it shortly after it starts and every 6 hours. You can also press **Catalog → Sync now**.

| What | Where it comes from |
| --- | --- |
| Products, images, release dates | TCGplayer's Pokémon catalog, via the free daily mirror at [tcgcsv.com](https://tcgcsv.com). Sealed products from sets released in the last two years, plus upcoming ones; no single cards, cases or code cards. |
| Market price, lowest listing | TCGplayer prices, via tcgcsv.com |
| 7- and 30-day change | `catalog/history.json`, the daily market prices the workflow records |
| MSRP | `catalog/sources/msrp.json`: confirmed prices per product, else the usual price for that product type (shown with ≈) |
| Store links | `catalog/sources/links.json` (checked by hand). With a `BESTBUY_API_KEY` repo secret (free from developer.bestbuy.com), Best Buy's official API is searched too. Target's product search is tried best-effort. Links found by search say so in the entry's notes. |

- **Margin** = market price − MSRP.
- **Hottest** ranks by margin, counted both as a percentage and in dollars (each on a log scale, so a $50 box reselling for $155 beats a $10 tin at $45), plus the weekly price change.
- **Hot** badge: in the top 15% by that ranking while reselling 50%+ over retail, or up 15%+ in a week.
- The feed keeps up to 250 products: everything with store links or not out yet, then the best scores.

**Sync rules:**

- New products are added, and prices refresh.
- Fields you edited (a name, an MSRP, a store link) are kept.
- A product you delete stays deleted.
- A product the feed drops is removed only if you never edited it and no task uses it.
- Entries you add yourself are never touched.

**Why not Collectr or PriceCharting?** Collectr has no public API. PriceCharting's API needs a paid subscription. TCGplayer closed its own API to new developers, and tcgcsv.com publishes the same TCGplayer data openly.

To build the feed yourself: `npm run catalog:feed`. It writes `catalog/feed.json` and `catalog/history.json`. To use another feed, change **Settings → Catalog feed → Feed URL**.

## How a task runs

```
Start → check sign-in → prepare (warm session, check cart) → monitor stock
      → in stock and ≤ max price → (waiting room? wait in it) → add to cart
      → checkout: fill empty shipping fields → saved card by last 4, or type in the stored card
      → review page: card last 4 ✓  ship-to ZIP + street ✓  subtotal ≤ max × qty ✓
      → dry run: stop here      live: place order → confirmation + order number
```

**Stored cards at checkout:**

- A card saved on the account with the same last 4 is always tried first.
- Otherwise the app opens the store's "Add a card" form and types the card in.
- Card fields can sit in the page itself or in a payment processor's secure iframe (Cybersource, Adyen, Braintree, Stripe and others). Billing fields get the profile's billing address.
- If the store asks for the security code, including once right after "Place order", the app enters it.
- Card data only goes to frames on the store's own domain or a known payment processor.

| Status | Meaning |
| --- | --- |
| Idle | Not running |
| Monitoring | Checking stock every few seconds |
| In stock | Found it; waiting for a checkout slot or adding to cart |
| In queue | A waiting room is holding the task; it waits its turn |
| Carted | In the cart (also the final state of a dry run) |
| Checking out | On the checkout page |
| Checked out | Order placed |
| Paused | Needs you: challenge, sign-in, CVV, or a check that did not pass |
| Failed | Stopped: payment declined, setup problem, or too many failures in a row |

## Multi-account tasks (groups)

1. **Accounts → Bulk add**: pick the store, optionally a default profile, then paste `email:password` lines (or load a .txt/.csv). Everything after the first `:` is the password, so passwords may contain `:` or `,`. Duplicates and logins already saved are skipped.
2. **Tasks → New task**: tick several accounts (**All**, **None** or **First N**). You get one task per account in one group.
   - **Use each account's default profile**: each account checks out with its own saved card and address.
   - **Copies per account**: usually 1.
   - **Stop group after N orders**: the limit is checked right before each order is submitted, so accounts running in parallel cannot overshoot it. When it's reached, the rest of the group stops.
3. Use the group filter on the Tasks tab to start or stop a whole group.

Each account has its own isolated browser profile, cookies and (optional) proxy. One account being challenged or blocked doesn't affect the others.

## How each store is handled

HTTP is used wherever the store's flow allows it. A hidden browser window, with the account's own isolated profile, is used where the flow needs the store's page.

| Store | Stock check | Keyword search | Add to cart | Checkout | Queue |
| --- | --- | --- | --- | --- | --- |
| Target | redsky JSON API (HTTP) | redsky search (HTTP) | Cart API (HTTP); product page if needed | target.com checkout page | — |
| Best Buy | Official Products API with your key; otherwise the button-state API (HTTP) | Official API with key; otherwise search page | Cart API (HTTP) | Fast-track checkout page | "Please Wait" add-to-cart queue is waited out, not skipped |
| Amazon | Product page (HTTP), incl. who sells it | Search page (HTTP) | **Buy Now** in the window (only this item, cart untouched) | Buy Now panel or checkout page | — |
| Pokémon Center | Product page structured data (HTTP) | Search page (HTTP) | Product page in the window | Cart → checkout pages | Waiting room joined per account and watched until it passes |

**Amazon:** "Only buy when sold by Amazon.com" is on by default, so marked-up third-party listings are skipped.

## Speed

- **Stock checks:** shared per product, with backoff and `Retry-After` respected.
- **Warm sessions:** each running account's session is pinged every few minutes, so sign-in doesn't happen at drop time.
- **Before the drop:** the cart contents and sign-in are checked up front.
- **Parallel tasks:** run on async I/O with a global concurrency cap on checkouts.
- **Hidden windows:** they skip images and are opened only when needed.

## Safety and privacy

- **Credentials:** accounts, profiles, tasks and settings are encrypted on disk with **Windows DPAPI** (Electron `safeStorage`). Accounts refuse to save if OS encryption is unavailable.
- **Stored cards:**
  - **Opt-in, one per profile.** They live in their own DPAPI-encrypted file (`data\cards.json`), and the app refuses to store a card without strong OS encryption.
  - **Never shown back.** The number and security code never reach the app's UI: after saving you only see the brand, last 4, expiry and name.
  - **Never logged.** The number is masked in every log line and notification.
  - **One place only.** They're typed only into the store's checkout page. Deleting a profile (or switching it back to "Saved on the store account") deletes its card.
- **Passwords:** never sent to the UI, never logged. Every log line and notification goes through redaction (passwords, tokens, cookies, card-like numbers, emails).
- **Discord messages:** show no emails, passwords or full addresses. Profile names and order numbers are hidden behind spoiler tags.
- **Free-text fields:** reject anything that looks like a full card number (cards go only in the stored-card fields).
- **Windows and IPC:** store windows are sandboxed and can't open pop-ups or downloads. The app's own UI uses context isolation, a strict Content-Security-Policy, and a validated, allow-listed IPC bridge.
- **After "Place order" is clicked:** any uncertainty pauses the task. It never retries, so it can't order twice.

## When a store changes its site

Endpoints, the Target web key and page selectors live in a `DEFAULTS` object at the top of each file in `src/main/retailers/`. To change one without rebuilding, edit **Settings → Open retailer-overrides.json**, for example:

```json
{
  "target": { "placeOrderText": "^(place your order|submit order)$" },
  "bestbuy": { "checkoutUrl": "https://www.bestbuy.com/checkout/r/fast-track" }
}
```

Only keys that exist in `DEFAULTS`, with values of the same type, are applied. Stop and start tasks afterwards.

## Troubleshooting

- **Paused: CAPTCHA / bot challenge / blocked**: wait a while, or click the window icon on the task, handle it there, then press Start. The app won't try to get around it.
- **Paused: security code / card number requested**: add a stored card to the profile so the app can enter it, or finish the order in the task's window. The app notices the confirmation page and marks the task checked out.
- **Paused: could not enter the stored card**: the store's card form wasn't recognized (the message names the field). Finish in the window. If the card fields sit in a payment processor's frame that isn't covered, add its domain to `PAYMENT_FRAME_HOSTS` in `src/main/retailers/flows.ts`.
- **Signed out / 2FA**: Accounts → **Sign in** opens that account's window with the login filled in. Finish 2FA and close the window.
- **Pokémon Center keyword tasks find nothing**: the search page may be rendered in the browser only. Use product URLs for Pokémon Center.
- **Where is my data?** `%APPDATA%\Pokemon ACO\`
  - `data\` – encrypted settings, tasks, profiles, accounts, stored cards
  - `catalog.json` – editable catalog
  - `retailer-overrides.json` – store overrides
  - `logs\` – 14 days of logs

## Honest limitations

- The store flows were written from their public web pages and APIs. The whole engine was tested end to end against a local mock store. That covered:
  - stock change, cart, guarded checkout, dry run and a live order
  - a group limit with parallel accounts, a block pausing a task, and the kill switch
  - a fresh account checking out with a stored card: shipping form, card in a cross-origin processor iframe, separate billing address, and a security-code prompt after "Place order"

  They were **not** tested against live drops. Store sites change often; expect to adjust an endpoint or selector through `retailer-overrides.json` now and then.
- Stores run bot protection. Because this app never evades it, some attempts will be paused for you instead of completing on their own. That trade-off is intentional.
- Best Buy and some Target sessions can't be confirmed signed-in over plain HTTP. Their sign-in is checked in the window before the drop.
- **Catalog data:**
  - Store links exist only for some products: hand-checked ones, plus what the store searches find.
  - An MSRP marked ≈ is the usual price for the product type, not a confirmed one.
  - Market prices are TCGplayer's, so they follow TCGplayer sales rather than eBay or local prices.

---

## Project structure

```
build/                 icon.ico / icon.png (generated by scripts/make-icon.mjs)
catalog/               feed.json (rebuilt daily), history.json (daily prices), sources/ (MSRPs,
                       hand-checked links), default-catalog.json (first-run seed)
scripts/               build, dev runner, esbuild config, icon generator, catalog/ (feed builder)
src/shared/            types, IPC contract, zod schemas, URL/keyword/proxy/price parsing
src/main/
  core/                encrypted JSON storage, DPAPI, redaction, log bus, notifications
  data/                settings, tasks, profiles, accounts, catalog, overrides
  engine/              sessions, HTTP client, hidden browser, detection, guards,
                       stock monitor, task runner, task manager, keep-alive
  retailers/           target, bestbuy, amazon, pokemoncenter + shared flows
  ipc.ts index.ts      IPC handlers and app lifecycle
  updater.ts           auto-update from GitHub Releases (installed Windows app only)
src/preload/           the allow-listed bridge between UI and main process
src/renderer/          React UI: Tasks, Profiles, Accounts, Catalog, Updates, Settings
tests/                 unit tests for the pure logic
.github/workflows/     CI (Linux), the Windows installer build and release publishing, daily catalog feed
```

**Adding a store:** implement `RetailerModule` (`src/main/retailers/types.ts`), add its id to `RETAILER_IDS` and its metadata to `src/shared/retailers.ts`, then register it in `src/main/retailers/registry.ts`.

## Credits

- **Font:** [Lexend](https://github.com/googlefonts/lexend), SIL Open Font License 1.1, bundled in `src/renderer/assets/fonts/`.
- **Icons:** [Lucide](https://lucide.dev), ISC.
