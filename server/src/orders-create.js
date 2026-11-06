/**
 * Task 1 — `orders/create` webhook logic.
 * Generates a random Lorem Ipsum text and stores it in an order metafield
 * (`$app.random_text`, type `multi_line_text_field`, declared in shopify.app.toml).
 */
import { generateLoremIpsum } from "./lorem.js";

export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation SetOrderRandomText($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

export const DEFINITION_QUERY = /* GraphQL */ `
  query RandomTextDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
    metafieldDefinition(identifier: $identifier) { id pinnedPosition }
  }
`;

export const DEFINITION_PIN_MUTATION = /* GraphQL */ `
  mutation PinRandomTextDefinition($definitionId: ID!) {
    metafieldDefinitionPin(definitionId: $definitionId) {
      pinnedDefinition { id pinnedPosition }
      userErrors { field message }
    }
  }
`;

/**
 * Admin only shows *pinned* metafield definitions on the order page. App-owned definitions
 * declared in shopify.app.toml are not pinned by default, so we pin ours once per shop
 * (best effort: failures are reported to the caller but never affect the webhook).
 */
export function createDefinitionPinner({ admin, config }) {
  const done = new Set();
  const inFlight = new Map();

  async function pin(shop) {
    const identifier = { ownerType: "ORDER", namespace: config.metafieldNamespace, key: config.metafieldKey };
    const { metafieldDefinition: definition } = await admin.graphql(shop, DEFINITION_QUERY, { identifier });
    if (!definition) throw new Error("Metafield definition not found (is the app deployed and installed?)");
    if (definition.pinnedPosition == null) {
      const { metafieldDefinitionPin: result } = await admin.graphql(shop, DEFINITION_PIN_MUTATION, {
        definitionId: definition.id,
      });
      if (result.userErrors.length) throw new Error(`metafieldDefinitionPin: ${JSON.stringify(result.userErrors)}`);
    }
    done.add(shop);
    return definition.pinnedPosition == null ? "pinned" : "already-pinned";
  }

  return function ensurePinned(shop) {
    if (done.has(shop)) return Promise.resolve("cached");
    if (!inFlight.has(shop)) {
      inFlight.set(shop, pin(shop).finally(() => inFlight.delete(shop)));
    }
    return inFlight.get(shop);
  };
}

/**
 * @param {{ shop: string, order: any }} input
 * @param {{ admin: { graphql: Function }, config: any, generateText?: () => string }} deps
 */
export async function handleOrderCreated({ shop, order }, { admin, config, generateText = generateLoremIpsum }) {
  const ownerId = order?.admin_graphql_api_id ?? (order?.id ? `gid://shopify/Order/${order.id}` : null);
  if (!ownerId) throw new Error("Webhook payload does not contain an order id");

  const data = await admin.graphql(shop, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId,
        namespace: config.metafieldNamespace,
        key: config.metafieldKey,
        type: "multi_line_text_field",
        value: generateText(),
      },
    ],
  });

  const { metafields, userErrors } = data.metafieldsSet;
  if (userErrors.length) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(userErrors)}`);
  }
  return { ownerId, metafield: metafields[0] };
}
