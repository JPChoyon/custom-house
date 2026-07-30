import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import { parseVariantMapping } from "../services/zakeke/zakeke-products.server";

type ProductPayload = {
  id?: number | string;
  status?: string;
  variants?: Array<{ id?: number | string; sku?: string | null }>;
};

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const product = payload as ProductPayload;
  const productId = `gid://shopify/Product/${String(product.id || "")}`;
  const mapping = await db.globalProductMapping.findUnique({
    where: {
      shop_shopifyProductId: { shop, shopifyProductId: productId },
    },
  });
  if (!mapping) return new Response();

  const availableVariants = new Set(
    (product.variants || [])
      .map((variant) => String(variant.id || ""))
      .filter((id) => /^\d+$/.test(id))
      .map((id) => `gid://shopify/ProductVariant/${id}`),
  );
  const current = parseVariantMapping(mapping.variantMappingJson);
  const variants = current.variants.filter((variant) =>
    availableVariants.has(variant.shopifyVariantId),
  );
  const active = String(product.status || "").toLowerCase() === "active";
  await db.globalProductMapping.update({
    where: { id: mapping.id },
    data: {
      variantMappingJson: JSON.stringify({ variants }),
      enabled: active && mapping.enabled,
      status: active
        ? mapping.status === "ACTIVE"
          ? "ACTIVE"
          : "TESTING"
        : "DISABLED",
      lastSyncedAt: new Date(),
    },
  });
  const linked = await db.creatorDesign.findMany({
    where: { shop, globalProductMappingId: mapping.id },
    select: {
      id: true,
      status: true,
      shopifyCreatorProductId: true,
      compatibleVariantIdsJson: true,
    },
  });
  const allowed = variants
    .filter((variant) => variant.enabled !== false)
    .map((variant) => variant.shopifyVariantId);
  if ((!active || !allowed.length) && admin) {
    const client = new AdminGraphqlClient(admin);
    for (const design of linked) {
      if (!design.shopifyCreatorProductId || design.status !== "ACTIVE") {
        continue;
      }
      try {
        await client.request(
          `#graphql mutation HideStaleZakekeProduct($product: ProductUpdateInput!) {
            productUpdate(product: $product) { userErrors { message } }
          }`,
          {
            product: {
              id: design.shopifyCreatorProductId,
              status: "DRAFT",
            },
          },
        );
      } catch {
        // The local error state keeps the product out of purchase endpoints.
      }
    }
  }
  await db.creatorDesign.updateMany({
    where: { shop, globalProductMappingId: mapping.id },
    data: {
      compatibleVariantIdsJson: JSON.stringify(allowed),
      ...(!active || !allowed.length
        ? {
            status: "HIDDEN" as const,
            syncStatus: "HIDDEN" as const,
            hiddenReason: !active
              ? "GLOBAL_PRODUCT_INACTIVE"
              : "NO_COMPATIBLE_VARIANTS",
            wasPublishedBeforeSuspension: true,
          }
        : {}),
    },
  });
  return new Response();
}
