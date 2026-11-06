/**
 * Runtime configuration, read once from environment variables.
 * A tiny `.env` loader is included so local development needs no extra packages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

loadDotEnv(fileURLToPath(new URL("../../.env", import.meta.url)));

export const config = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  apiKey: process.env.SHOPIFY_API_KEY ?? "",
  apiSecret: process.env.SHOPIFY_API_SECRET ?? "",
  /** Optional static Admin API token. When absent, the client credentials grant is used. */
  adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "",
  apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-10",
  metafieldNamespace: process.env.METAFIELD_NAMESPACE ?? "$app",
  metafieldKey: process.env.METAFIELD_KEY ?? "random_text",
});

export function assertConfig() {
  const missing = [];
  if (!config.apiSecret) missing.push("SHOPIFY_API_SECRET");
  if (!config.adminAccessToken && !config.apiKey) missing.push("SHOPIFY_API_KEY");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function loadDotEnv(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return; // No .env file: rely on the real environment (production).
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue; // Real env always wins.
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}
