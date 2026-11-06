/**
 * Entry point: `npm start` (or `node server/src/index.js`).
 * Uses only Node.js built-ins — no npm dependencies.
 */
import { createServer } from "node:http";
import { config, assertConfig } from "./config.js";
import { createAdminClient } from "./shopify-admin.js";
import { createApp } from "./app.js";

assertConfig();

const app = createApp({ config, admin: createAdminClient({ config }) });

createServer(app).listen(config.port, () => {
  console.log(`Webhook server listening on port ${config.port}`);
});
