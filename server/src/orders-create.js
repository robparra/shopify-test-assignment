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
