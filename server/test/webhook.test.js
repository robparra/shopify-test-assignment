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
import { handleOrderCreated, createDefinitionEnsurer } from "../src/orders-create.js";
import { createApp } from "../src/app.js";

const SECRET = "test_secret";
const SHOP = "demo-store.myshopify.com";
const config = {
  apiKey: "test_key",
  apiSecret: SECRET,
  adminAccessToken: "",
  apiVersion: "2026-10",
  metafieldNamespace: "custom",
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
      namespace: "custom",
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

describe("createDefinitionEnsurer", () => {
  const fakeAdmin = ({ existing = null, createErrors = [], pinErrors = [] } = {}) => {
    const calls = [];
    return {
      calls,
      graphql: async (_shop, query, variables) => {
        calls.push({ query, variables });
        if (query.includes("metafieldDefinitionCreate")) {
          return { metafieldDefinitionCreate: { createdDefinition: { id: "gid://shopify/MetafieldDefinition/9" }, userErrors: createErrors } };
        }
        if (query.includes("metafieldDefinitionPin")) {
          return { metafieldDefinitionPin: { pinnedDefinition: { id: existing.id }, userErrors: pinErrors } };
        }
        return { metafieldDefinition: existing };
      },
    };
  };

  test("creates a pinned custom.random_text definition when missing, once per shop", async () => {
    const admin = fakeAdmin();
    const ensure = createDefinitionEnsurer({ admin, config });

    assert.equal(await ensure(SHOP), "created");
    assert.equal(await ensure(SHOP), "cached");
    assert.equal(admin.calls.length, 2);
    assert.deepEqual(admin.calls[0].variables.identifier, { ownerType: "ORDER", namespace: "custom", key: "random_text" });
    const { definition } = admin.calls[1].variables;
    assert.equal(definition.pin, true);
    assert.equal(definition.type, "multi_line_text_field");
    assert.equal(definition.ownerType, "ORDER");
  });

  test("pins an existing unpinned definition", async () => {
    const admin = fakeAdmin({ existing: { id: "gid://shopify/MetafieldDefinition/1", pinnedPosition: null } });
    assert.equal(await createDefinitionEnsurer({ admin, config })(SHOP), "pinned");
    assert.equal(admin.calls[1].variables.definitionId, "gid://shopify/MetafieldDefinition/1");
  });

  test("does nothing when the definition is already pinned", async () => {
    const admin = fakeAdmin({ existing: { id: "gid://shopify/MetafieldDefinition/1", pinnedPosition: 1 } });
    assert.equal(await createDefinitionEnsurer({ admin, config })(SHOP), "exists");
    assert.equal(admin.calls.length, 1);
  });

  test("tolerates a concurrent create (TAKEN) and reports other errors", async () => {
    const taken = fakeAdmin({ createErrors: [{ code: "TAKEN", message: "Key is in use" }] });
    assert.equal(await createDefinitionEnsurer({ admin: taken, config })(SHOP), "created");

    const failing = fakeAdmin({ createErrors: [{ code: "INVALID", message: "bad" }] });
    await assert.rejects(createDefinitionEnsurer({ admin: failing, config })(SHOP), /bad/);
  });
});

describe("HTTP endpoint", () => {
  let server;
  let baseUrl;
  const writes = [];
  const definitionCalls = [];
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
    const ensureDefinition = async (shop) => (definitionCalls.push(shop), "created");
    server = createServer(createApp({ config, admin, logger: silentLogger, ensureDefinition }));
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
    assert.ok(definitionCalls.includes(SHOP), "definition is ensured before writing");
  });

  test("still saves the value when the definition setup fails", async () => {
    const admin = {
      graphql: async (_shop, _query, variables) => {
        writes.push(variables.metafields[0]);
        return { metafieldsSet: { metafields: [{}], userErrors: [] } };
      },
    };
    const failing = createServer(
      createApp({ config, admin, logger: silentLogger, ensureDefinition: async () => { throw new Error("nope"); } }),
    );
    await new Promise((resolve) => failing.listen(0, resolve));
    const body = JSON.stringify({ id: 11 });
    const res = await fetch(`http://127.0.0.1:${failing.address().port}/webhooks/orders/create`, {
      method: "POST",
      headers: { "X-Shopify-Hmac-Sha256": sign(body), "X-Shopify-Shop-Domain": SHOP, "X-Shopify-Topic": "orders/create" },
      body,
    });
    failing.close();
    assert.equal(res.status, 200);
    assert.equal(writes.at(-1).ownerId, "gid://shopify/Order/11");
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
