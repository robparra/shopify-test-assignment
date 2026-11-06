import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the `X-Shopify-Hmac-Sha256` header against the raw request body.
 * Must run on the *raw* bytes — re-serialised JSON would produce a different digest.
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook
 */
export function isValidShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
