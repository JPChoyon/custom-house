import db from "../../db.server";
import { DomainError } from "../domain";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server";
import {
  getZakekeFeatureFlags,
  getZakekePublicConfiguration,
} from "./zakeke-config.server";
import type {
  ZakekeVariantMappingDocument,
} from "./zakeke-types";
import { parseVariantMapping } from "./zakeke-mapping";

export { parseVariantMapping } from "./zakeke-mapping";

export type VerifiedZakekeProduct = {
  id: string;
  title: string;
  handle: string;
  tags: string[];
  variants: Array<{
    id: string;
    sku: string | null;
    price: string;
    availableForSale: boolean;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

export async function verifyGlobalZakekeProduct(
  client: ShopifyGraphqlClient,
  productId: string,
): Promise<VerifiedZakekeProduct> {
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      tags: string[];
      status: string;
      productType: { value: string } | null;
      zakekeEnabled: { value: string } | null;
      origin: { value: string } | null;
      designMode: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          sku: string | null;
          price: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query ZakekeGlobalProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        tags
        status
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        zakekeEnabled: metafield(namespace: "customhouse", key: "zakeke_enabled") { value }
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        variants(first: 100) {
          nodes {
            id
            sku
            price
            availableForSale
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  const isNewGlobal =
    product?.productType?.value === "global_customizable" &&
    product.zakekeEnabled?.value === "true";
  const isLegacyGlobal =
    product?.origin?.value === "global" &&
    product.designMode?.value === "customizable";
  if (
    !product ||
    product.status !== "ACTIVE" ||
    (!isNewGlobal && !isLegacyGlobal)
  ) {
    throw new DomainError(
      "ZAKEKE_PRODUCT_UNAVAILABLE",
      "This product is not enabled for Zakeke customization.",
      409,
    );
  }
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    tags: product.tags,
    variants: product.variants.nodes,
  };
}

export async function requireActiveGlobalProductMapping(
  shop: string,
  productId: string,
) {
  if (!getZakekeFeatureFlags().integration) {
    throw new DomainError(
      "ZAKEKE_DISABLED",
      "Product customization is not available.",
      404,
    );
  }
  const testProductId =
    getZakekePublicConfiguration().testShopifyProductId;
  if (testProductId && productId !== testProductId) {
    throw new DomainError(
      "ZAKEKE_PRODUCT_NOT_ALLOWLISTED",
      "This product is not included in the Zakeke proof of concept.",
      404,
    );
  }
  const mapping = await db.globalProductMapping.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId: productId } },
  });
  if (
    !mapping ||
    !mapping.enabled ||
    !["TESTING", "ACTIVE"].includes(mapping.status)
  ) {
    throw new DomainError(
      "ZAKEKE_MAPPING_MISSING",
      "This product is not connected to Zakeke.",
      409,
    );
  }
  return {
    ...mapping,
    variantMapping: parseVariantMapping(mapping.variantMappingJson),
  };
}

export function requireMappedVariant(
  mapping: ZakekeVariantMappingDocument,
  variantId: string,
) {
  const variant = mapping.variants.find(
    (item) => item.shopifyVariantId === variantId && item.enabled !== false,
  );
  if (!variant) {
    throw new DomainError(
      "ZAKEKE_VARIANT_INCOMPATIBLE",
      "This product option has not passed Zakeke compatibility testing.",
      409,
    );
  }
  return variant;
}

export async function saveGlobalProductMapping(input: {
  shop: string;
  client: ShopifyGraphqlClient;
  shopifyProductId: string;
  zakekeProductCode: string;
  variantMappingJson: string;
  enabled: boolean;
  status: "DRAFT" | "TESTING" | "ACTIVE" | "DISABLED" | "ERROR";
}) {
  const product = await verifyGlobalZakekeProduct(
    input.client,
    input.shopifyProductId,
  );
  const variantMapping = parseVariantMapping(input.variantMappingJson);
  const productVariantIds = new Set(product.variants.map((item) => item.id));
  if (
    variantMapping.variants.some(
      (item) => !productVariantIds.has(item.shopifyVariantId),
    )
  ) {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "The mapping contains a variant that does not belong to this product.",
      422,
    );
  }
  const code = input.zakekeProductCode.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/.test(code)) {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "Enter a valid Zakeke product code.",
      422,
    );
  }
  return db.globalProductMapping.upsert({
    where: {
      shop_shopifyProductId: {
        shop: input.shop,
        shopifyProductId: input.shopifyProductId,
      },
    },
    create: {
      shop: input.shop,
      shopifyProductId: input.shopifyProductId,
      shopifyProductHandle: product.handle,
      zakekeProductCode: code,
      variantMappingJson: JSON.stringify(variantMapping),
      enabled: input.enabled,
      status: input.status,
      lastSyncedAt: new Date(),
    },
    update: {
      shopifyProductHandle: product.handle,
      zakekeProductCode: code,
      variantMappingJson: JSON.stringify(variantMapping),
      enabled: input.enabled,
      status: input.status,
      lastSyncedAt: new Date(),
    },
  });
}
