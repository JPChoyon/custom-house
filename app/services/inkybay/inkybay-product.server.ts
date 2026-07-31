import { DomainError } from "../domain";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server";

export type VerifiedInkyBayProduct = {
  id: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  tags: string[];
  variants: Array<{
    id: string;
    title: string;
    availableForSale: boolean;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

export async function verifyInkyBayGlobalProduct(
  client: ShopifyGraphqlClient,
  productId: string,
  variantId?: string | null,
) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new DomainError(
      "SOURCE_PRODUCT_INVALID",
      "Choose a valid source product.",
      422,
    );
  }
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      status: string;
      tags: string[];
      featuredImage: { url: string } | null;
      productType: { value: string } | null;
      inkybayEnabled: { value: string } | null;
      creatorPublishingEnabled: { value: string } | null;
      legacyOrigin: { value: string } | null;
      legacyMode: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          title: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query InkyBayCreatorSource($id: ID!) {
      product(id: $id) {
        id title handle status tags
        featuredImage { url }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
        creatorPublishingEnabled: metafield(namespace: "customhouse", key: "creator_publishing_enabled") { value }
        legacyOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        legacyMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        variants(first: 100) {
          nodes { id title availableForSale selectedOptions { name value } }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  const isGlobal =
    product?.productType?.value === "global_customizable" ||
    (product?.legacyOrigin?.value === "global" &&
      product.legacyMode?.value === "customizable");
  if (
    !product ||
    product.status !== "ACTIVE" ||
    !isGlobal ||
    product.inkybayEnabled?.value !== "true" ||
    product.creatorPublishingEnabled?.value !== "true"
  ) {
    throw new DomainError(
      "SOURCE_PRODUCT_NOT_ELIGIBLE",
      "This product is not enabled for creator publishing.",
      409,
    );
  }
  if (variantId) {
    const variant = product.variants.nodes.find((item) => item.id === variantId);
    if (!variant?.availableForSale) {
      throw new DomainError(
        "SOURCE_VARIANT_UNAVAILABLE",
        "The selected product option is unavailable.",
        409,
      );
    }
  }
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: product.featuredImage?.url || null,
    tags: product.tags,
    variants: product.variants.nodes,
  } satisfies VerifiedInkyBayProduct;
}
