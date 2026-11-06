/**
 * Unit tests for the upsell business rules (built-in `node:test`, no dependencies).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fetchCollectionProducts, getVisibleProducts, parseCollectionSetting, toCandidate } from "../src/upsell.js";

const product = (n, overrides = {}) => ({
  id: `gid://shopify/Product/${n}`,
  title: `Product ${n}`,
  requiresSellingPlan: false,
  featuredImage: { url: `https://cdn/p${n}.jpg`, altText: null },
  variants: {
    nodes: [
      { id: `gid://shopify/ProductVariant/${n}1`, title: "Default Title", availableForSale: true, image: null, price: { amount: "10.0", currencyCode: "USD" } },
      { id: `gid://shopify/ProductVariant/${n}2`, title: "Large", availableForSale: true, image: null, price: { amount: "12.0", currencyCode: "USD" } },
    ],
  },
  ...overrides,
});

const candidates = [1, 2, 3, 4, 5].map((n) => toCandidate(product(n)));
const line = (productN, variantSuffix = 1) => ({
  merchandise: {
    id: `gid://shopify/ProductVariant/${productN}${variantSuffix}`,
    product: { id: `gid://shopify/Product/${productN}` },
  },
});
const titles = (list) => list.map((p) => p.title);

describe("getVisibleProducts", () => {
  test("shows the first 2 products in collection order", () => {
    assert.deepEqual(titles(getVisibleProducts(candidates, [])), ["Product 1", "Product 2"]);
  });

  test("replaces one product already in the cart with the next one", () => {
    assert.deepEqual(titles(getVisibleProducts(candidates, [line(1)])), ["Product 2", "Product 3"]);
  });

  test("replaces both products when both are in the cart", () => {
    assert.deepEqual(titles(getVisibleProducts(candidates, [line(1), line(2)])), ["Product 3", "Product 4"]);
  });

  test("treats any variant of a product as 'in cart'", () => {
    assert.deepEqual(titles(getVisibleProducts(candidates, [line(1, 2)])), ["Product 2", "Product 3"]);
  });

  test("shows a single product when only one is left", () => {
    const cart = [1, 2, 3, 4].map((n) => line(n));
    assert.deepEqual(titles(getVisibleProducts(candidates, cart)), ["Product 5"]);
  });

  test("shows nothing when every product is in the cart", () => {
    const cart = [1, 2, 3, 4, 5].map((n) => line(n));
    assert.deepEqual(getVisibleProducts(candidates, cart), []);
  });

  test("ignores cart lines from outside the collection", () => {
    assert.deepEqual(titles(getVisibleProducts(candidates, [line(99)])), ["Product 1", "Product 2"]);
  });
});

describe("toCandidate", () => {
  test("uses the first available variant", () => {
    const p = product(7);
    p.variants.nodes[0].availableForSale = false;
    const c = toCandidate(p);
    assert.equal(c.variantId, "gid://shopify/ProductVariant/72");
    assert.equal(c.variantTitle, "Large");
  });

  test("drops sold-out and subscription-only products", () => {
    const soldOut = product(8);
    soldOut.variants.nodes.forEach((v) => (v.availableForSale = false));
    assert.equal(toCandidate(soldOut), null);
    assert.equal(toCandidate(product(9, { requiresSellingPlan: true })), null);
  });
});

describe("parseCollectionSetting", () => {
  test("accepts handle, URL, numeric id, admin URL and GID", () => {
    assert.deepEqual(parseCollectionSetting(" Summer-Sale "), { handle: "summer-sale" });
    assert.deepEqual(parseCollectionSetting("https://shop.com/collections/summer-sale?page=2"), { handle: "summer-sale" });
    assert.deepEqual(parseCollectionSetting("123"), { id: "gid://shopify/Collection/123" });
    assert.deepEqual(parseCollectionSetting("https://admin.shopify.com/store/x/collections/456"), { id: "gid://shopify/Collection/456" });
    assert.deepEqual(parseCollectionSetting("https://x.myshopify.com/admin/collections/789"), { id: "gid://shopify/Collection/789" });
    assert.deepEqual(parseCollectionSetting("gid://shopify/Collection/42"), { id: "gid://shopify/Collection/42" });
  });

  test("returns null for empty or invalid values", () => {
    assert.equal(parseCollectionSetting(""), null);
    assert.equal(parseCollectionSetting(undefined), null);
    assert.equal(parseCollectionSetting("not a handle!"), null);
  });
});

describe("fetchCollectionProducts", () => {
  test("follows pagination and keeps collection order", async () => {
    const pages = [
      { nodes: [product(1), product(2)], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [product(3)], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const calls = [];
    const query = async (q, { variables }) => {
      calls.push(variables);
      return { data: { collection: { products: pages[calls.length - 1] } } };
    };
    const { found, products } = await fetchCollectionProducts(query, { handle: "sale" });
    assert.equal(found, true);
    assert.deepEqual(titles(products), ["Product 1", "Product 2", "Product 3"]);
    assert.equal(calls[1].after, "c1");
    assert.equal(calls[0].handle, "sale");
  });

  test("reports a missing collection", async () => {
    const result = await fetchCollectionProducts(async () => ({ data: { collection: null } }), { id: "gid://shopify/Collection/1" });
    assert.deepEqual(result, { found: false, products: [] });
  });
});
