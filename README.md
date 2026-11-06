# Order Text & Checkout Upsell — Shopify test assignment

A Shopify app with two parts:

| Task | What it does | Where |
|------|--------------|-------|
| **1. `orders/create` webhook** | Generates a random Lorem Ipsum text for every new order and saves it in the order metafield `$app.random_text` (`multi_line_text_field`). | [`server/`](server), [`shopify.app.toml`](shopify.app.toml) |
| **2. Checkout upsell block** | Checkout UI Extension that shows 2 products from a merchant-selected collection, in collection order, with an **Add** button, skipping/replacing products already in the cart. | [`extensions/checkout-upsell/`](extensions/checkout-upsell) |

No extra libraries: the webhook server uses **only Node.js built-ins** (`node:http`, `node:crypto`, global `fetch`), and the extension uses only the packages Shopify's official template requires (`preact`, `@preact/signals`, `@shopify/ui-extensions`). Tests use the built-in `node:test` runner.

---

## Project structure

```
.
├── shopify.app.toml                  # App config: scopes, orders/create subscription, metafield definition
├── render.yaml                       # Optional one-click hosting for the webhook server
├── server/
│   ├── src/
│   │   ├── index.js                  # Entry point (npm start)
│   │   ├── app.js                    # Routing, HMAC check, idempotency, error handling
│   │   ├── orders-create.js          # Task 1 logic: metafieldsSet mutation
│   │   ├── shopify-admin.js          # Admin GraphQL client + client-credentials token cache
│   │   ├── hmac.js                   # Webhook signature verification (timing-safe)
│   │   ├── lorem.js                  # Random Lorem Ipsum generator
│   │   └── config.js                 # Env vars (+ tiny .env loader)
│   └── test/webhook.test.js
└── extensions/checkout-upsell/
    ├── shopify.extension.toml        # Target, api_access, Checkout editor settings
    ├── locales/                      # en (default), es
    ├── src/
    │   ├── Checkout.jsx              # Preact UI (Polaris web components)
    │   └── upsell.js                 # Pure business rules (fetch, filter, order)
    └── tests/upsell.test.js
```

---

## Task 1 — `orders/create` webhook

**Flow**

1. `shopify.app.toml` declares the subscription (`[[webhooks.subscriptions]] topics = ["orders/create"]`) and an **app-owned metafield definition** (`[order.metafields.app.random_text]`). Both are created automatically by `shopify app deploy` — no manual setup in the admin.
2. Shopify `POST`s the order to `/webhooks/orders/create`.
3. The server:
   - verifies `X-Shopify-Hmac-Sha256` over the **raw body** with the app secret (timing-safe compare);
   - validates the topic and `X-Shopify-Shop-Domain` (`*.myshopify.com` only);
   - skips duplicate deliveries using `X-Shopify-Event-Id` (Shopify delivers *at least once*);
   - generates 1–3 random Lorem Ipsum paragraphs (`crypto.randomInt`);
   - calls the Admin GraphQL `metafieldsSet` mutation on the order's `admin_graphql_api_id`;
   - answers `200`, or `500` on failure so **Shopify retries automatically**.

**Authentication without a database.** The server obtains Admin API tokens with the [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant) (available when the app and the store belong to the same organization, which is the case for a dev store created from the Partner/Dev Dashboard). Tokens are cached in memory per shop and refreshed before they expire (24 h). If needed, a static `SHOPIFY_ADMIN_ACCESS_TOKEN` can be provided instead.

**Where to see the result:** Admin → Orders → open an order → *Metafields* section → **Random text**. Or via GraphQL:

```graphql
{ order(id: "gid://shopify/Order/123") { metafield(namespace: "$app", key: "random_text") { value } } }
```

## Task 2 — Checkout upsell (Checkout UI Extensions)

Target `purchase.checkout.block.render` (default placement: order summary, movable in the editor). API version `2026-10`, Preact + Polaris web components.

| Requirement | Implementation |
|---|---|
| Display 2 products at a time | `PRODUCTS_PER_VIEW = 2` in `getVisibleProducts()` |
| "Add" button per card | `<s-button>` → `shopify.applyCartLinesChange({ type: "addCartLine" })`, with loading state and error banner |
| Products from a selected collection | Storefront API via `shopify.query` (`api_access = true`), all pages fetched (up to 250 products) |
| Same order as in the collection | `products(sortKey: COLLECTION_DEFAULT)` respects the collection's manual or automatic sort |
| Products in the cart are not shown | Compared by **product ID** (any variant of that product counts) against `shopify.lines` |
| Replace added products with the next ones | `shopify.lines` is a signal: when the cart changes the list is recomputed and the next products in collection order slide in |
| Hide when everything was added | `getVisibleProducts()` returns `[]` → the extension renders nothing |
| Collection setting in the Checkout customizer | `[extensions.settings]` field **Upsell collection** (+ optional **Heading**) |

**About the collection setting.** Checkout UI extension settings don't offer a collection picker (the supported types are text, number, boolean, date and `variant_reference`), so the setting is a text field that accepts any convenient format: handle (`summer-sale`), storefront URL (`…/collections/summer-sale`), admin URL (`admin.shopify.com/store/x/collections/123`), numeric ID or GID.

**Extra behaviour**

- Sold-out products and subscription-only products (`requiresSellingPlan`) are skipped, since they can't be added; the first *available* variant is used.
- Loading skeleton while the collection loads; double-clicks are prevented while a line is being added.
- Configuration errors (empty/invalid setting, collection not found) are shown **only in the Checkout editor**; buyers never see a broken block.
- Respects `instructions.lines.canAddCartLine` (e.g. draft-order checkouts).
- Translations: English and Spanish.

---

## Setup & deployment

### Prerequisites

- Node.js ≥ 20.10 and [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (installed as a dev dependency).
- A Partner account and a **dev store on the Plus plan**: Dev Dashboard → Stores → Create store → **Dev** → plan **Plus** (or `shopify store create dev --plan plus`). Don't use a *client transfer store*: custom/draft apps can't be installed there.

### 1. Install and link the app

```bash
npm install
npm run config:link        # creates/links the app in your Partner org and fills client_id
```

### 2. Deploy the webhook server

Any Node host works (Render, Railway, Fly.io, a VPS…). With Render:

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → select the repository (uses [`render.yaml`](render.yaml)).
3. Set `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` (app → *Settings* → Client ID / Client secret).
4. Check `https://<your-service>.onrender.com/health` returns *"webhook server is running"*.

> Render's free plan sleeps after 15 min of inactivity. To keep it always awake, a free monitor ([cron-job.org](https://cron-job.org) / [UptimeRobot](https://uptimerobot.com)) pings `/health` every 10 minutes (750 free hours/month cover a single service 24/7). As a safety net, if a delivery ever hits a cold start, Shopify retries it automatically (up to 8 times over 4 hours) and the retry succeeds. Use a paid instance for production.

### 3. Point the app at the server and deploy

Replace `REPLACE-WITH-YOUR-SERVER.onrender.com` in [`shopify.app.toml`](shopify.app.toml) with your server's host, then:

```bash
npm run deploy             # releases app config (webhook + metafield definition) and the extension
```

### 4. Install and configure in the store

1. Partner/Dev Dashboard → your app → **Install app** on the dev store (scopes: `read_orders`, `write_orders`).
2. Protected customer data: the webhook only needs **Level 1** (order data, no name/email/address fields). Custom-distribution apps and apps installed only on dev stores get it without review. If `shopify app deploy` rejects the `orders/create` subscription, either set the app's distribution to **Custom** for your store, or request it in Partner Dashboard → Apps → your app → **API access requests → Protected customer data access**.
3. Admin → **Settings → Checkout → Customize** → *Add app block* → **Collection upsell** → set **Upsell collection** → **Save**.

### Local development

```bash
cp .env.example .env       # fill SHOPIFY_API_KEY / SHOPIFY_API_SECRET
npm start                  # webhook server on http://localhost:3000
npm run dev                # Shopify CLI: preview the checkout extension
npm test                   # 26 unit/integration tests, built-in node:test
```

Trigger a test webhook: `shopify app webhook trigger --topic orders/create --address https://<your-server>/webhooks/orders/create` (note: the sample payload references a non-existent order, so the metafield write will fail — create a real order to test end to end).

---

## How to verify

1. **Task 1:** create an order (Admin → Orders → Create order, or place a test order with the *Bogus Gateway*) → open it → *Metafields* → **Random text** contains Lorem Ipsum. Each order gets a different text.
2. **Task 2:** add any product to the cart → go to checkout → the block shows the first 2 products of the collection. Click **Add** → the product goes to the cart and the next product from the collection takes its place. Add all of them → the block disappears.
