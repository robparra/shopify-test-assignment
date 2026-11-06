/**
 * Pure, framework-agnostic helpers for the upsell block.
 * Kept free of Preact / `shopify` globals so they can be unit tested with `node:test`.
 */

export const PRODUCTS_PER_VIEW = 2;
export const PAGE_SIZE = 50;
export const MAX_PAGES = 5; // Up to 250 products from the collection.

/**
 * The merchant can paste the collection in the most convenient form:
 *   - handle:        "summer-sale"
 *   - admin/store URL: "https://shop.com/collections/summer-sale" or ".../admin/collections/123"
 *   - numeric ID:    "123456789"
 *   - GID:           "gid://shopify/Collection/123456789"
 * @returns {{ id: string } | { handle: string } | null}
 */
export function parseCollectionSetting(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return null;

  const gid = value.match(/^gid:\/\/shopify\/Collection\/(\d+)$/i);
  if (gid) return { id: `gid://shopify/Collection/${gid[1]}` };

  // Admin URLs: admin.shopify.com/store/<store>/collections/123 or <shop>/admin/collections/123
  const isAdminUrl = /admin\.shopify\.com|\/admin\//i.test(value);
  const adminId = isAdminUrl && value.match(/\/collections\/(\d+)/i);
  if (adminId) return { id: `gid://shopify/Collection/${adminId[1]}` };

  if (/^\d+$/.test(value)) return { id: `gid://shopify/Collection/${value}` };

  const storeUrl = value.match(/\/collections\/([a-z0-9][a-z0-9_-]*)/i);
  if (storeUrl) return { handle: storeUrl[1].toLowerCase() };

  if (/^[a-z0-9][a-z0-9_-]*$/i.test(value)) return { handle: value.toLowerCase() };

  return null;
}

/**
 * Storefront API query. `sortKey: COLLECTION_DEFAULT` returns products in the exact order
 * configured for the collection in the admin (manual or automatic sort).
 */
export function buildCollectionQuery(reference) {
  const [argDef, argUse] = "id" in reference ? ["$id: ID!", "id: $id"] : ["$handle: String!", "handle: $handle"];
  return /* GraphQL */ `
    query UpsellCollection(${argDef}, $first: Int!, $after: String) {
      collection(${argUse}) {
        id
        title
        products(first: $first, after: $after, sortKey: COLLECTION_DEFAULT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            requiresSellingPlan
            featuredImage { url altText }
            variants(first: 25) {
              nodes {
                id
                title
                availableForSale
                image { url altText }
                price { amount currencyCode }
              }
            }
          }
        }
      }
    }
  `;
}

/**
 * Fetches every page of the collection (up to MAX_PAGES) and normalises it into
 * purchasable upsell candidates, preserving collection order.
 * @param {(query: string, options: object) => Promise<{data?: any, errors?: any[]}>} query
 */
export async function fetchCollectionProducts(query, reference) {
  const graphql = buildCollectionQuery(reference);
  const products = [];
  let after = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, errors } = await query(graphql, {
      variables: { ...reference, first: PAGE_SIZE, after },
    });
    if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));

    const connection = data?.collection?.products;
    if (!connection) return { found: false, products: [] };

    products.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return { found: true, products: products.map(toCandidate).filter(Boolean) };
}

/** Picks the first variant that can be bought; drops products that can't be added. */
export function toCandidate(product) {
  if (!product || product.requiresSellingPlan) return null;
  const variant = product.variants?.nodes?.find((v) => v.availableForSale);
  if (!variant) return null;

  const image = variant.image ?? product.featuredImage ?? null;
  return {
    productId: product.id,
    variantIds: product.variants.nodes.map((v) => v.id),
    variantId: variant.id,
    title: product.title,
    variantTitle: variant.title && variant.title !== "Default Title" ? variant.title : "",
    imageUrl: image?.url ?? "",
    imageAlt: image?.altText || product.title,
    price: variant.price,
  };
}

/**
 * Core business rule: skip every product already in the cart (any of its variants) and
 * take the next ones in collection order, so the block always shows up to 2 products.
 * Returns an empty array once every product from the collection has been added.
 */
export function getVisibleProducts(candidates, cartLines, limit = PRODUCTS_PER_VIEW) {
  const productIdsInCart = new Set();
  const variantIdsInCart = new Set();
  for (const line of cartLines ?? []) {
    const merchandise = line?.merchandise;
    if (!merchandise) continue;
    if (merchandise.id) variantIdsInCart.add(merchandise.id);
    if (merchandise.product?.id) productIdsInCart.add(merchandise.product.id);
  }

  const visible = [];
  for (const candidate of candidates) {
    const inCart =
      productIdsInCart.has(candidate.productId) ||
      candidate.variantIds.some((id) => variantIdsInCart.has(id));
    if (inCart) continue;
    visible.push(candidate);
    if (visible.length === limit) break;
  }
  return visible;
}
