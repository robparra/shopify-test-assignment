/**
 * Task 2 — Collection-driven upsell block for Checkout (Checkout UI Extensions, Preact).
 *
 * - Products come from the collection selected in the Checkout editor (setting `collection`).
 * - Shows 2 products at a time, in collection order, each with an "Add" button.
 * - Products already in the cart are skipped and replaced by the next ones.
 * - When every product of the collection is in the cart, nothing is rendered.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { PRODUCTS_PER_VIEW, fetchCollectionProducts, getVisibleProducts, parseCollectionSetting } from "./upsell.js";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  // `.value` reads are signals: the component re-renders when settings or cart lines change.
  const settings = shopify.settings.value;
  const cartLines = shopify.lines.value;
  const canAddCartLine = shopify.instructions.value?.lines?.canAddCartLine !== false;
  const isEditor = Boolean(shopify.extension.editor);

  const collectionSetting = typeof settings.collection === "string" ? settings.collection : "";
  const heading = (typeof settings.heading === "string" && settings.heading.trim()) || i18n.translate("heading");

  const [state, setState] = useState({ status: "idle", products: [] });
  const [addingVariantId, setAddingVariantId] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  // (Re)load the collection whenever the merchant changes the setting.
  useEffect(() => {
    const reference = parseCollectionSetting(collectionSetting);
    if (!reference) {
      setState({ status: collectionSetting ? "invalid" : "unconfigured", products: [] });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", products: [] });
    fetchCollectionProducts(shopify.query, reference)
      .then(({ found, products }) => {
        if (!cancelled) setState({ status: found ? "ready" : "notFound", products });
      })
      .catch((error) => {
        console.error("[checkout-upsell] Failed to load collection", error);
        if (!cancelled) setState({ status: "error", products: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [collectionSetting]);

  // Auto-dismiss the error banner.
  useEffect(() => {
    if (!errorMessage) return undefined;
    const timer = setTimeout(() => setErrorMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [errorMessage]);

  async function addToCart(product) {
    setAddingVariantId(product.variantId);
    setErrorMessage("");
    try {
      const result = await shopify.applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: product.variantId,
        quantity: 1,
      });
      if (result.type === "error") {
        console.error("[checkout-upsell]", result.message);
        setErrorMessage(i18n.translate("addError"));
      }
      // On success `shopify.lines` updates → the product disappears and the next one slides in.
    } catch (error) {
      console.error("[checkout-upsell]", error);
      setErrorMessage(i18n.translate("addError"));
    } finally {
      setAddingVariantId(null);
    }
  }

  if (!canAddCartLine) return null;

  // Configuration problems are only surfaced to the merchant inside the Checkout editor;
  // buyers never see a broken block.
  if (["unconfigured", "invalid", "notFound", "error"].includes(state.status)) {
    return isEditor ? <s-banner tone="warning" heading={heading}>{i18n.translate(`editor.${state.status}`)}</s-banner> : null;
  }

  if (state.status === "loading" || state.status === "idle") {
    return <UpsellSkeleton heading={heading} />;
  }

  const visibleProducts = getVisibleProducts(state.products, cartLines, PRODUCTS_PER_VIEW);
  if (!visibleProducts.length) return null;

  return (
    <s-section heading={heading}>
      <s-stack gap="base">
        {visibleProducts.map((product) => (
          <ProductCard
            key={product.productId}
            product={product}
            loading={addingVariantId === product.variantId}
            disabled={addingVariantId !== null && addingVariantId !== product.variantId}
            onAdd={() => addToCart(product)}
          />
        ))}
        {errorMessage && <s-banner tone="critical">{errorMessage}</s-banner>}
      </s-stack>
    </s-section>
  );
}

function ProductCard({ product, loading, disabled, onAdd }) {
  const { i18n } = shopify;
  const price = i18n.formatCurrency(Number(product.price.amount), { currency: product.price.currencyCode });

  return (
    <s-grid gap="base" gridTemplateColumns="64px 1fr auto" alignItems="center">
      <s-product-thumbnail src={product.imageUrl} alt={product.imageAlt} />
      <s-stack gap="none">
        <s-text type="strong">{product.title}</s-text>
        {product.variantTitle && <s-text color="subdued">{product.variantTitle}</s-text>}
        <s-text color="subdued">{price}</s-text>
      </s-stack>
      <s-button
        variant="secondary"
        loading={loading}
        disabled={disabled}
        accessibilityLabel={i18n.translate("addAccessibilityLabel", { title: product.title })}
        onClick={onAdd}
      >
        {i18n.translate("add")}
      </s-button>
    </s-grid>
  );
}

function UpsellSkeleton({ heading }) {
  return (
    <s-section heading={heading}>
      <s-stack gap="base">
        {Array.from({ length: PRODUCTS_PER_VIEW }, (_, index) => (
          <s-grid key={index} gap="base" gridTemplateColumns="64px 1fr auto" alignItems="center">
            <s-product-thumbnail />
            <s-stack gap="small-200">
              <s-skeleton-paragraph />
              <s-skeleton-paragraph />
            </s-stack>
            <s-button variant="secondary" disabled>
              {shopify.i18n.translate("add")}
            </s-button>
          </s-grid>
        ))}
      </s-stack>
    </s-section>
  );
}
