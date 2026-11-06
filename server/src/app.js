/**
 * Request handler for the zero-dependency webhook server.
 *
 * Routes
 *   GET  /, /health               -> health check / app landing page
 *   POST /webhooks/orders/create  -> Task 1 webhook
 */
import { isValidShopifyHmac } from "./hmac.js";
import { isValidShopDomain } from "./shopify-admin.js";
import { handleOrderCreated, createDefinitionPinner } from "./orders-create.js";

const MAX_BODY_BYTES = 1024 * 1024; // Order payloads are far below 1 MB.
const PROCESSED_EVENTS_LIMIT = 1000;

export function createApp({ config, admin, logger = console, ensurePinned = createDefinitionPinner({ admin, config }) }) {
  // Shopify delivers webhooks "at least once": remember recent event ids so a duplicate
  // delivery does not overwrite the text that was already generated for the order.
  const processedEvents = new Set();
  const rememberEvent = (id) => {
    processedEvents.add(id);
    if (processedEvents.size > PROCESSED_EVENTS_LIMIT) {
      processedEvents.delete(processedEvents.values().next().value);
    }
  };

  return async function app(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      return send(res, 200, "Order Text & Checkout Upsell: webhook server is running.");
    }
    if (pathname !== "/webhooks/orders/create") return send(res, 404, "Not found");
    if (req.method !== "POST") return send(res, 405, "Method not allowed");

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch {
      return send(res, 413, "Payload too large");
    }

    // 1. Authenticity: HMAC over the raw body, signed with the app's client secret.
    if (!isValidShopifyHmac(rawBody, req.headers["x-shopify-hmac-sha256"], config.apiSecret)) {
      return send(res, 401, "Invalid HMAC");
    }

    const shop = req.headers["x-shopify-shop-domain"];
    const topic = req.headers["x-shopify-topic"];
    const eventId = req.headers["x-shopify-event-id"] ?? req.headers["x-shopify-webhook-id"];

    if (topic && topic !== "orders/create") return send(res, 400, `Unexpected topic ${topic}`);
    if (!isValidShopDomain(shop)) return send(res, 400, "Invalid shop domain");
    // 2. Idempotency.
    if (eventId && processedEvents.has(eventId)) return send(res, 200, "Already processed");

    let order;
    try {
      order = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return send(res, 400, "Invalid JSON");
    }

    // 3. Processing takes well under Shopify's 5 s timeout, so it runs before replying:
    //    on failure we answer 500 and Shopify retries the delivery automatically.
    try {
      const { ownerId } = await handleOrderCreated({ shop, order }, { admin, config });
      if (eventId) rememberEvent(eventId);
      logger.log(`[orders/create] Saved random text metafield on ${ownerId} (${shop})`);
      send(res, 200, "OK");
      // After replying: make the metafield visible on the order page (best effort).
      ensurePinned(shop)
        .then((status) => status === "pinned" && logger.log(`[orders/create] Pinned metafield definition (${shop})`))
        .catch((error) => logger.error(`[orders/create] Could not pin metafield definition: ${error.message}`));
      return;
    } catch (error) {
      logger.error(`[orders/create] Failed for ${shop}: ${error.message}`);
      return send(res, 500, "Processing failed");
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
