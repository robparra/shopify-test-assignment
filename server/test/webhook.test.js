/**
 * Tests use only the built-in `node:test` runner. Run with `npm test`.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

import { generateLoremIpsum, sentence } from "../src/lorem.js";
import { isValidShopifyHmac } from "../src/hmac.js";
import { createAdminClient, isValidShopDomain } from "../src/shopify-admin.js";
import { handleOrderCreated } from "../src/orders-create.js";
import { createApp } from "../src/app.js";

const SECRET = "test_secret";
const SHOP = "demo-store.myshopify.com";
const config = {
  apiKey: "test_key",
  apiSecret: SECRET,
  adminAccessToken: "",
  apiVersion: "2026-10",
  metafieldNamespace: "$app",
  metafieldKey: "random_text",
};
const sign = (body) => createHmac("sha256", SECRET).update(body).digest("base64");
const silentLogger = { log() {}, error() {} };

describe("lorem", () => {
  test("generates capitalised sentences ending with a period", () => {
    const s = sentence();
    assert.match(s, /^[A-Z][a-z, ]+\.$/);
  });

  test("generates different text on each call", () => {
    const texts = new Set(Array.from({ length: 20 }, () => generateLoremIpsum()));
    assert.ok(texts.size > 15);
  });
});

describe("hmac", () => {
  test("accepts a valid signature and rejects tampering", () => {
    const body = Buffer.from('{"id":1}');
    assert.equal(isValidShopifyHmac(body, sign(body), SECRET), true);
    assert.equal(isValidShopifyHmac(Buffer.from('{"id":2}'), sign(body), SECRET), false);
    assert.equal(isValidShopifyHmac(body, undefined, SECRET), false);
    assert.equal(isValidShopifyHmac(body, "short", SECRET), false);
  });
});

describe("shop domain validation", () => {
  test("only accepts *.myshopify.com", () => {
    assert.equal(isValidShopDomain(SHOP), true);
    assert.equal(isValidShopDomain("evil.com"), false);
    assert.equal(isValidShopDomain("a.myshopify.com.evil.com"), false);
  });
});

describe("admin client", () => {
  test("uses the client credentials grant and caches the token", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/admin/oauth/access_token")) {
        return Response.json({ access_token: "tok_123", expires_in: 86399 });
      }
      return Response.json({ data: { ok: true } });
    };
    const admin = createAdminClient({ config, fetchImpl });
    await admin.graphql(SHOP, "{ shop { id } }");
    await admin.graphql(SHOP, "{ shop { id } }");

    const tokenCalls = calls.filter((c) => c.url.endsWith("/access_token"));
    assert.equal(tokenCalls.length, 1, "token must be cached");
    assert.match(String(tokenCalls[0].init.body), /grant_type=client_credentials/);
    assert.equal(calls[1].init.headers["X-Shopify-Access-Token"], "tok_123");
    assert.equal(calls[1].url, `https://${SHOP}/admin/api/2026-10/graphql.json`);
  });

  test("prefers a static token when configured", async () => {
    const urls = [];
    const fetchImpl = async (url) => (urls.push(url), Response.json({ data: {} }));
    const admin = createAdminClient({ config: { ...config, adminAccessToken: "shpat_x" }, fetchImpl });
    await admin.graphql(SHOP, "{ shop { id } }");
    assert.deepEqual(urls, [`https://${SHOP}/admin/api/2026-10/graphql.json`]);
  });
});

describe("handleOrderCreated", () => {
  test("writes the generated text into the order metafield", async () => {
    let captured;
    const admin = {
      graphql: async (shop, query, variables) => {
        captured = { shop, query, variables };
        return { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] } };
      },
    };
    const result = await handleOrderCreated(
      { shop: SHOP, order: { id: 42, admin_graphql_api_id: "gid://shopify/Order/42" } },
      { admin, config, generateText: () => "Lorem ipsum." },
    );

    assert.equal(result.ownerId, "gid://shopify/Order/42");
    assert.match(captured.query, /metafieldsSet/);
    assert.deepEqual(captured.variables.metafields[0], {
      ownerId: "gid://shopify/Order/42",
      namespace: "$app",
      key: "random_text",
      type: "multi_line_text_field",
      value: "Lorem ipsum.",
    });
  });

  test("throws on userErrors so the webhook is retried", async () => {
    const admin = {
      graphql: async () => ({ metafieldsSet: { metafields: [], userErrors: [{ message: "nope" }] } }),
    };
    await assert.rejects(handleOrderCreated({ shop: SHOP, order: { id: 1 } }, { admin, config }), /nope/);
  });
});

describe("HTTP endpoint", () => {
  let server;
  let baseUrl;
  const writes = [];
  let failNext = false;

  before(async () => {
    const admin = {
      graphql: async (shop, _query, variables) => {
        if (failNext) {
          failNext = false;
          throw new Error("boom");
        }
        writes.push({ shop, ...variables.metafields[0] });
        return { metafieldsSet: { metafields: [{}], userErrors: [] } };
      },
    };
    server = createServer(createApp({ config, admin, logger: silentLogger }));
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const post = (body, headers = {}) =>
    fetch(`${baseUrl}/webhooks/orders/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": sign(body),
        "X-Shopify-Shop-Domain": SHOP,
        "X-Shopify-Topic": "orders/create",
        ...headers,
      },
      body,
    });

  test("health check", async () => {
    assert.equal((await fetch(`${baseUrl}/`)).status, 200);
  });

  test("rejects requests with an invalid HMAC", async () => {
    const res = await post('{"id":1}', { "X-Shopify-Hmac-Sha256": "invalid" });
    assert.equal(res.status, 401);
    assert.equal(writes.length, 0);
  });

  test("processes a valid webhook and ignores duplicate deliveries", async () => {
    const body = JSON.stringify({ id: 7, admin_graphql_api_id: "gid://shopify/Order/7" });
    const first = await post(body, { "X-Shopify-Event-Id": "evt-1" });
    const duplicate = await post(body, { "X-Shopify-Event-Id": "evt-1" });

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ownerId, "gid://shopify/Order/7");
    assert.ok(writes[0].value.length > 20);
  });

  test("answers 500 on failure so Shopify retries", async () => {
    failNext = true;
    const res = await post(JSON.stringify({ id: 8 }), { "X-Shopify-Event-Id": "evt-2" });
    assert.equal(res.status, 500);
  });

  test("rejects non-myshopify shop domains", async () => {
    const res = await post(JSON.stringify({ id: 9 }), { "X-Shopify-Shop-Domain": "evil.com" });
    assert.equal(res.status, 400);
  });
});
