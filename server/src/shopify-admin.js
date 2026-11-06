/**
 * Minimal Shopify Admin GraphQL client built on the global `fetch` (Node >= 18).
 *
 * Authentication strategy:
 *  1. If SHOPIFY_ADMIN_ACCESS_TOKEN is set, it is used as-is.
 *  2. Otherwise the app obtains a token with the *client credentials grant*, available for
 *     apps installed on stores owned by the same organization as the app (e.g. a dev store
 *     created from the Partner / Dev Dashboard). Tokens last 24h and are cached per shop in
 *     memory, so the server stays stateless — no database or OAuth session storage needed.
 *     https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
 */

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function isValidShopDomain(shop) {
  return typeof shop === "string" && SHOP_DOMAIN_RE.test(shop);
}

export function createAdminClient({ config, fetchImpl = globalThis.fetch, now = Date.now }) {
  /** @type {Map<string, {token: string, expiresAt: number}>} */
  const tokenCache = new Map();

  async function getAccessToken(shop) {
    if (config.adminAccessToken) return config.adminAccessToken;

    const cached = tokenCache.get(shop);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;

    const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.apiKey,
        client_secret: config.apiSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`Access token request failed (${response.status}): ${await response.text()}`);
    }
    const { access_token: token, expires_in: expiresIn = 86_399 } = await response.json();
    tokenCache.set(shop, { token, expiresAt: now() + expiresIn * 1000 });
    return token;
  }

  async function graphql(shop, query, variables = {}) {
    if (!isValidShopDomain(shop)) throw new Error(`Invalid shop domain: ${shop}`);

    const response = await fetchImpl(`https://${shop}/admin/api/${config.apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getAccessToken(shop),
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401) tokenCache.delete(shop); // Force a fresh token on retry.
    if (!response.ok) {
      throw new Error(`Admin API request failed (${response.status}): ${await response.text()}`);
    }
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`Admin API GraphQL errors: ${JSON.stringify(payload.errors)}`);
    }
    return payload.data;
  }

  return { graphql, getAccessToken };
}
