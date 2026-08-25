import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { inkyBayProductContract } from "./inkybay/inkybay-product.server.ts";
import { normalizeCustomerGid } from "./helium-sync.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import {
  clonePitchPrintProject,
  type PitchPrintProjectCloner,
} from "./pitchprint-clone.server.ts";
import { signCreatorAttribution } from "./creator-attribution.server.ts";
import {
  getCreatorCollectionByCreatorId,
  getPublicCreatorCollection,
} from "./creator-collections.server.ts";
import { createAdminNotification } from "./admin-notifications.server.ts";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls.ts";

export type CreatorProductRecord = {
  id: string;
  shop: string;
  creatorId: string;
  shopifyProductId: string;
  shopifyProductHandle: string | null;
  baseProductTitle: string;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  title: string;
  description: string | null;
  previewUrl: string | null;
  previewUrls: string;
  baseProductVariantsJson: string;
  designVariantSelectionsJson: string;
  status: string;
  submittedAt: Date | null;
  publishedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  publishedShopifyProductId?: string | null;
  publishedShopifyProductHandle?: string | null;
  publishedShopifyProductUrl?: string | null;
  shopifyPublishedAt?: Date | null;
  baseVariantMappingJson?: string;
  createdAt: Date;
  updatedAt: Date;
};

type CreatorProductDb = {
  creator: {
    findUnique(args: unknown): Promise<{
      id: string;
      handle?: string;
      status: string;
      marketplaceCollection?: {
        publicHandle: string;
        status: string;
        shopifyCollectionUrl?: string | null;
      } | null;
    } | null>;
    findFirst?(args: unknown): Promise<{
      id: string;
      handle: string;
      displayName: string;
      customerId?: string;
      status: string;
    } | null>;
  };
  creatorCollection?: {
    findFirst(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
  };
  creatorProduct: {
    create(args: unknown): Promise<CreatorProductRecord>;
    delete?(args: unknown): Promise<CreatorProductRecord>;
    findMany(args: unknown): Promise<CreatorProductRecord[]>;
    findFirst(args: unknown): Promise<CreatorProductRecord | null>;
    update(args: unknown): Promise<CreatorProductRecord>;
  };
  creatorSale?: {
    count(args?: unknown): Promise<number>;
  };
  creatorOrderItem?: {
    count(args?: unknown): Promise<number>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
};

export type CreateCreatorProductInput = {
  shopifyProductId: unknown;
  title?: unknown;
  description?: unknown;
  pitchprintDesignId?: unknown;
};

export type AttachPitchPrintProjectInput = {
  projectId: unknown;
  previews?: unknown;
  previewUrl?: unknown;
  designId?: unknown;
  variantSelections?: unknown;
};

export type UpdateCreatorProductDetailsInput = {
  title?: unknown;
  description?: unknown;
};

export type EligibleCreatorBaseProduct = {
  id: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  pitchprintDesignId: string | null;
  classification: "configured" | "legacy" | "compatible_fallback";
  variants: CreatorProductBaseVariant[];
};

export type CreatorProductBaseVariant = {
  id: string;
  graphqlId: string;
  variantId: string;
  title: string;
  size: string;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type DesignVariantSelection = {
  variantId: string;
  size: string;
  quantity: number;
};

export type AdminCreatorProductDecisionInput = {
  creatorProductId: unknown;
  decision: unknown;
  rejectionReason?: unknown;
};

export type PublicCreatorProductVariant = {
  id: string;
  graphqlId: string;
  cartId: string;
  numericId: string;
  title: string;
  availableForSale: boolean;
  price: {
    amount: string;
    currencyCode: string;
  };
  selectedOptions: Array<{ name: string; value: string }>;
};

export type PublicCreatorProductBase = {
  id: string;
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  options: Array<{ name: string; values: string[] }>;
  variants: PublicCreatorProductVariant[];
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
};

export type PublicCreatorProduct = CreatorProductRecord & {
  creator: {
    id: string;
    displayName: string;
    handle: string;
    customerId?: string;
  };
  collection: {
    id: string;
    publicHandle: string;
    displayName: string;
    creatorId: string;
  };
  baseProduct?: PublicCreatorProductBase;
};

export type PrepareCreatorProductCartInput = {
  creatorHandle?: unknown;
  publicHandle?: unknown;
  creatorProductId: unknown;
  selectedVariantId: unknown;
  quantity?: unknown;
};

export type PrepareNativeCreatorProductCartInput = {
  shopifyProductId: unknown;
  selectedVariantId: unknown;
  quantity?: unknown;
};

function cleanOptionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function cleanCreatorProductTitle(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "TITLE_REQUIRED",
      "Enter a design title.",
      422,
    );
  }
  const title = value.trim();
  if (!title) {
    throw new DomainError(
      "TITLE_REQUIRED",
      "Enter a design title.",
      422,
    );
  }
  if (title.length < 2) {
    throw new DomainError(
      "TITLE_TOO_SHORT",
      "Design title must be at least 2 characters.",
      422,
    );
  }
  if (title.length > 120) {
    throw new DomainError(
      "TITLE_TOO_LONG",
      "Design title must be 120 characters or less.",
      422,
    );
  }
  return title;
}

function cleanCreatorProductDescription(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new DomainError(
      "DESCRIPTION_INVALID",
      "Description must be plain text.",
      422,
    );
  }
  const description = value.trim();
  if (description.length > 1000) {
    throw new DomainError(
      "DESCRIPTION_TOO_LONG",
      "Description must be 1000 characters or less.",
      422,
    );
  }
  return description || null;
}

function normalizeShopifyProductGid(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "INVALID_PRODUCT",
      "Select a valid Shopify base product.",
      422,
    );
  }
  const trimmed = value.trim();
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(trimmed)) {
    throw new DomainError(
      "INVALID_PRODUCT",
      "Use the Shopify product GID for the base product.",
      422,
    );
  }
  return trimmed;
}

async function approvedCreatorForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb,
) {
  const creator = await database.creator.findUnique({
    where: {
      shop_customerId: {
        shop,
        customerId: normalizeCustomerGid(customerId),
      },
    },
    select: {
      id: true,
      handle: true,
      status: true,
      marketplaceCollection: {
        select: {
          publicHandle: true,
          status: true,
          shopifyCollectionUrl: true,
        },
      },
    },
  });
  if (!creator || creator.status !== "APPROVED") {
    throw new DomainError(
      "NOT_APPROVED",
      "Only approved creators can manage creator products.",
      403,
    );
  }
  return creator;
}

async function validateBaseProduct(
  client: ShopifyGraphqlClient,
  shopifyProductId: string,
) {
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      origin: { value: string } | null;
      mode: { value: string } | null;
      featuredMedia:
        | {
            preview?: {
              image?: {
                url: string;
              } | null;
            } | null;
          }
        | null;
      pitchprintDesignId: { value: string } | null;
      legacyPitchprintDesignId: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          title: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query CreatorProductBaseProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        featuredMedia {
          preview {
            image { url }
          }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: shopifyProductId },
  );
      const product = result.product;
  if (!product) {
    throw new DomainError(
      "PRODUCT_NOT_FOUND",
      "Base product not found.",
      404,
    );
  }
  if (product.origin?.value && product.origin.value !== "global") {
    throw new DomainError(
      "NOT_GLOBAL",
      "Creator Products must start from a Global Product.",
      422,
    );
  }
  if (product.mode?.value && product.mode.value !== "customizable") {
    throw new DomainError(
      "NOT_CUSTOMIZABLE",
      "This base product is not customizable.",
      422,
    );
  }
  return product;
}

function cleanProjectId(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "PitchPrint project ID is required.",
      422,
    );
  }
  const projectId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(projectId)) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_INVALID",
      "PitchPrint project ID is invalid.",
      422,
    );
  }
  return projectId;
}

function cleanPreviewUrls(input: AttachPitchPrintProjectInput) {
  const values = [
    ...(Array.isArray(input.previews) ? input.previews : []),
    input.previewUrl,
  ];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => {
          try {
            const url = new URL(item);
            return url.protocol === "https:";
          } catch {
            return false;
          }
        })
        .slice(0, 10),
    ),
  ];
}

function cleanPitchPrintDesignId(value: unknown) {
  if (typeof value !== "string") return null;
  const designId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(designId)
    ? designId
    : null;
}

function sizeValueFromOptions(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  const size = selectedOptions.find((option) =>
    /^(size|storlek|storrelse|storlek)$/i.test(option.name.trim()),
  );
  return cleanOptionalText(size?.value, 80) || null;
}

function creatorProductBaseVariants(product: {
  variants?: {
    nodes?: Array<{
      id: string;
      legacyResourceId?: string | number | null;
      title?: string | null;
      availableForSale?: boolean | null;
      selectedOptions?: Array<{ name: string; value: string }> | null;
    }>;
  } | null;
}) {
  const variants = product.variants?.nodes || [];
  return variants
    .map((variant): CreatorProductBaseVariant | null => {
      if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id)) return null;
      const selectedOptions = Array.isArray(variant.selectedOptions)
        ? variant.selectedOptions
            .map((option) => ({
              name: cleanOptionalText(option.name, 80) || "",
              value: cleanOptionalText(option.value, 120) || "",
            }))
            .filter((option) => option.name && option.value)
        : [];
      const variantId = cleanOptionalText(variant.legacyResourceId, 80) ||
        numericVariantId(variant.id);
      const title = cleanOptionalText(variant.title, 160) ||
        selectedOptions.map((option) => option.value).join(" / ") ||
        variantId;
      return {
        id: variant.id,
        graphqlId: variant.id,
        variantId,
        title,
        size: sizeValueFromOptions(selectedOptions) || title,
        availableForSale: variant.availableForSale !== false,
        selectedOptions,
      };
    })
    .filter((variant): variant is CreatorProductBaseVariant =>
      Boolean(variant && variant.availableForSale),
    );
}

function productBaseVariants(product: CreatorProductRecord) {
  try {
    const parsed = JSON.parse(product.baseProductVariantsJson || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((variant): variant is CreatorProductBaseVariant => {
          const record = variant as Record<string, unknown>;
          return Boolean(
            record &&
            typeof record === "object" &&
            typeof record.variantId === "string" &&
            typeof record.size === "string",
          );
        })
      : [];
  } catch {
    return [];
  }
}

function variantKeySet(variants: CreatorProductBaseVariant[]) {
  const keys = new Set<string>();
  variants.forEach((variant) => {
    keys.add(variant.variantId);
    keys.add(variant.id);
    keys.add(variant.graphqlId);
  });
  return keys;
}

function cleanDesignVariantSelections(
  value: unknown,
  variants: CreatorProductBaseVariant[],
) {
  const input = Array.isArray(value) ? value : [];
  const byKey = new Map<string, CreatorProductBaseVariant>();
  variants.forEach((variant) => {
    byKey.set(variant.variantId, variant);
    byKey.set(variant.id, variant);
    byKey.set(variant.graphqlId, variant);
  });
  const totals = new Map<string, number>();
  input.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const key = cleanOptionalText(record.variantId, 120) ||
      cleanOptionalText(record.id, 120) ||
      cleanOptionalText(record.graphqlId, 120);
    const variant = key ? byKey.get(key) : null;
    const quantity = Number(record.quantity ?? 0);
    if (!variant || !Number.isSafeInteger(quantity) || quantity <= 0) return;
    totals.set(variant.variantId, (totals.get(variant.variantId) || 0) + quantity);
  });
  return [...totals.entries()].map(([variantId, quantity]) => {
    const variant = byKey.get(variantId)!;
    return {
      variantId,
      size: variant.size,
      quantity,
    };
  });
}

function requireDesignVariantSelections(product: CreatorProductRecord) {
  const variants = productBaseVariants(product);
  const validKeys = variantKeySet(variants);
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(product.designVariantSelectionsJson || "[]");
  } catch {
    parsed = [];
  }
  const selections = Array.isArray(parsed)
    ? parsed.filter(
        (selection): selection is DesignVariantSelection =>
          selection &&
          typeof selection === "object" &&
          typeof selection.variantId === "string" &&
          typeof selection.size === "string" &&
          Number.isSafeInteger(selection.quantity) &&
          selection.quantity > 0 &&
          validKeys.has(selection.variantId),
      )
    : [];
  if (!selections.length) {
    throw new DomainError(
      "DESIGN_VARIANT_SELECTION_REQUIRED",
      "Select at least one size and quantity.",
      422,
    );
  }
  return selections;
}

function previewUrlsForProduct(product: CreatorProductRecord) {
  try {
    const parsed = JSON.parse(product.previewUrls || "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.startsWith("https://"),
        )
      : [];
  } catch {
    return [];
  }
}

function creatorCartPreviewUrl(product: CreatorProductRecord) {
  if (product.previewUrl?.startsWith("https://")) return product.previewUrl;
  return previewUrlsForProduct(product)[0] || null;
}

function validateCompletableCreatorProduct(product: CreatorProductRecord) {
  if (!cleanOptionalText(product.title, 140)) {
    throw new DomainError(
      "CREATOR_PRODUCT_TITLE_REQUIRED",
      "Add a title before submitting.",
      422,
    );
  }
  if (!cleanPitchPrintDesignId(product.pitchprintDesignId)) {
    throw new DomainError(
      "PITCHPRINT_DESIGN_REQUIRED",
      "This Creator Product is missing a PitchPrint design ID.",
      422,
    );
  }
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "Save your PitchPrint design before submitting.",
      422,
    );
  }
  const previews = previewUrlsForProduct(product);
  if (!product.previewUrl?.startsWith("https://") && previews.length === 0) {
    throw new DomainError(
      "CREATOR_PRODUCT_PREVIEW_REQUIRED",
      "Product preview is missing.",
      422,
    );
  }
  requireDesignVariantSelections(product);
}

function cleanRejectionReason(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function cleanCreatorProductId(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "CREATOR_PRODUCT_INVALID",
      "Choose a valid creator product.",
      422,
    );
  }
  const id = value.trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) {
    throw new DomainError(
      "CREATOR_PRODUCT_INVALID",
      "Choose a valid creator product.",
      422,
    );
  }
  return id;
}

function cleanQuantity(value: unknown) {
  const quantity = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
    throw new DomainError(
      "QUANTITY_INVALID",
      "Choose a valid quantity.",
      422,
    );
  }
  return quantity;
}

function cleanProductGidOrNumeric(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(raw)) return raw;
  throw new DomainError(
    "INVALID_PRODUCT",
    "Select a valid Shopify product.",
    422,
  );
}

function cleanVariantGidOrNumeric(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) return raw;
  throw new DomainError(
    "VARIANT_INVALID",
    "Choose a valid product option.",
    422,
  );
}

function cleanVariantSelection(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw) || /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) {
    return raw;
  }
  throw new DomainError(
    "VARIANT_INVALID",
    "Choose a valid product option.",
    422,
  );
}

function numericVariantId(variantGid: string) {
  return variantGid.split("/").pop() || "";
}

async function preparePitchPrintOrderProject(
  masterProjectId: string,
  cloner: PitchPrintProjectCloner,
) {
  try {
    return await cloner(masterProjectId);
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "PITCHPRINT_NOT_CONFIGURED"
    ) {
      console.warn("pitchprint_clone_not_configured_using_master_project", {
        projectPresent: Boolean(masterProjectId),
      });
      return masterProjectId;
    }
    throw error;
  }
}

async function verifyNativeVariant(
  client: ShopifyGraphqlClient,
  productId: string,
  variantId: string,
) {
  const result = await client.request<{
    productVariant: {
      id: string;
      availableForSale: boolean;
      product: { id: string } | null;
    } | null;
  }>(
    `#graphql query NativeCreatorCartVariant($id: ID!) {
      productVariant(id: $id) {
        id
        availableForSale
        product { id }
      }
    }`,
    { id: variantId },
  );
  const variant = result.productVariant;
  if (!variant || variant.product?.id !== productId || !variant.availableForSale) {
    throw new DomainError(
      "VARIANT_NOT_AVAILABLE",
      "Choose an available option for this product.",
      409,
    );
  }
  return variant;
}

function baseVariantForPublishedVariant(
  product: CreatorProductRecord,
  publishedVariantId: string,
) {
  try {
    const parsed = JSON.parse(product.baseVariantMappingJson || "{}");
    return parsed && typeof parsed === "object"
      ? String(parsed[publishedVariantId] || "")
      : "";
  } catch {
    return "";
  }
}

async function publicBaseProduct(
  productId: string,
  client: ShopifyGraphqlClient,
): Promise<PublicCreatorProductBase> {
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      onlineStoreUrl: string | null;
      options: Array<{ name: string; values: string[] }>;
      priceRangeV2: {
        minVariantPrice: { amount: string; currencyCode: string };
        maxVariantPrice: { amount: string; currencyCode: string };
      };
      variants: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          title: string;
          availableForSale: boolean;
          price: string;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query PublicCreatorProductBase($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        onlineStoreUrl
        options { name values }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
            price
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  if (!product) {
    throw new DomainError(
      "BASE_PRODUCT_NOT_FOUND",
      "This product is not available.",
      404,
    );
  }
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    onlineStoreUrl: product.onlineStoreUrl,
    options: product.options,
    priceRange: product.priceRangeV2,
    variants: product.variants.nodes.map((variant) => ({
      id: variant.id,
      graphqlId: variant.id,
      cartId: variant.legacyResourceId,
      numericId: variant.legacyResourceId,
      title: variant.title,
      availableForSale: variant.availableForSale,
      price: {
        amount: variant.price,
        currencyCode: product.priceRangeV2.minVariantPrice.currencyCode,
      },
      selectedOptions: variant.selectedOptions,
    })),
  };
}

function eligibleClassification(product: {
  status: string;
  tags: string[];
  productType: { value: string } | null;
  inkybayEnabled: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  creatorPublishingEnabled: { value: string } | null;
  legacyOrigin: { value: string } | null;
  legacyMode: { value: string } | null;
}) {
  if (product.status !== "ACTIVE") return null;
  const legacyGlobal = Boolean(
    product.legacyOrigin?.value === "global" &&
      product.legacyMode?.value === "customizable",
  );
  const contract = inkyBayProductContract({
    productType: legacyGlobal
      ? "global_customizable"
      : product.productType?.value || null,
    inkyBayEnabled: legacyGlobal || product.inkybayEnabled?.value === "true",
    pitchPrintEnabled:
      legacyGlobal || product.pitchprintEnabled?.value === "true",
    creatorPublishingEnabled:
      product.creatorPublishingEnabled?.value === "true",
    tags: product.tags,
  });
  if (contract.isCreatorFixed) return null;
  if (contract.isGlobalCustomizable) {
    return legacyGlobal ? "legacy" : "configured";
  }
  if (product.legacyOrigin?.value && product.legacyOrigin.value !== "global") {
    return null;
  }
  if (product.legacyMode?.value && product.legacyMode.value !== "customizable") {
    return null;
  }
  return "compatible_fallback";
}

export async function createCreatorProductDraft(
  shop: string,
  customerId: string,
  input: CreateCreatorProductInput,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const shopifyProductId = normalizeShopifyProductGid(input.shopifyProductId);
  const product = await validateBaseProduct(client, shopifyProductId);
  const pitchprintDesignId =
    cleanPitchPrintDesignId(input.pitchprintDesignId) ||
    cleanPitchPrintDesignId(product.pitchprintDesignId?.value) ||
    cleanPitchPrintDesignId(product.legacyPitchprintDesignId?.value);
  if (!pitchprintDesignId) {
    throw new DomainError(
      "PITCHPRINT_DESIGN_REQUIRED",
      "This base product is missing a PitchPrint design ID.",
      422,
    );
  }
  const previewUrl = product.featuredMedia?.preview?.image?.url || null;
  const title =
    cleanOptionalText(input.title, 140) || cleanOptionalText(product.title, 140);
  if (!title) {
    throw new DomainError(
      "INVALID_TITLE",
      "Creator Product title is required.",
      422,
    );
  }
  const baseProductVariants = creatorProductBaseVariants(product);

  const creatorProduct = await database.creatorProduct.create({
    data: {
      shop,
      creatorId: creator.id,
      shopifyProductId: product.id,
      shopifyProductHandle: product.handle,
      baseProductTitle: product.title,
      title,
      description: cleanOptionalText(input.description, 1000),
      pitchprintDesignId,
      previewUrl,
      previewUrls: safeJson(previewUrl ? [previewUrl] : []),
      baseProductVariantsJson: safeJson(baseProductVariants),
      designVariantSelectionsJson: "[]",
      status: "DRAFT",
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.created",
      entityType: "CreatorProduct",
      entityId: creatorProduct.id,
      afterJson: safeJson({
        creatorId: creator.id,
        shopifyProductId: product.id,
        status: "DRAFT",
      }),
    },
  });
  return creatorProduct;
}

export async function listEligibleCreatorBaseProducts(
  shop: string,
  customerId: string,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  await approvedCreatorForCustomer(shop, customerId, database);
  const result = await client.request<{
    products: {
      nodes: Array<{
        id: string;
        title: string;
        handle: string;
        status: string;
        tags: string[];
        featuredImage: { url: string } | null;
        productType: { value: string } | null;
        inkybayEnabled: { value: string } | null;
        pitchprintEnabled: { value: string } | null;
        creatorPublishingEnabled: { value: string } | null;
        legacyOrigin: { value: string } | null;
        legacyMode: { value: string } | null;
        pitchprintDesignId: { value: string } | null;
        legacyPitchprintDesignId: { value: string } | null;
        variants: {
          nodes: Array<{
            id: string;
            legacyResourceId: string;
            title: string;
            availableForSale: boolean;
            selectedOptions: Array<{ name: string; value: string }>;
          }>;
        };
      }>;
    };
  }>(
    `#graphql query CreatorBaseProducts {
      products(first: 50, query: "status:active") {
        nodes {
          id title handle status tags
          featuredImage { url }
          productType: metafield(namespace: "customhouse", key: "product_type") { value }
          inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
          pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
          creatorPublishingEnabled: metafield(namespace: "customhouse", key: "creator_publishing_enabled") { value }
          legacyOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
          legacyMode: metafield(namespace: "customhouse", key: "design_mode") { value }
          pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
          legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              title
              availableForSale
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
  );
  return result.products.nodes
    .map((product) => {
      const classification = eligibleClassification(product);
      if (!classification) return null;
      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        imageUrl: product.featuredImage?.url || null,
        pitchprintDesignId:
          product.pitchprintDesignId?.value ||
          product.legacyPitchprintDesignId?.value ||
          null,
        classification,
        variants: creatorProductBaseVariants(product),
      } satisfies EligibleCreatorBaseProduct;
    })
    .filter((product): product is EligibleCreatorBaseProduct =>
      Boolean(product),
    );
}

export async function creatorPitchPrintIdentityForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  return {
    userId: `customhouse:${shop}:creator:${creator.id}`,
  };
}

export async function attachPitchPrintProjectToCreatorProduct(
  shop: string,
  customerId: string,
  creatorProductId: string,
  input: AttachPitchPrintProjectInput,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!["DRAFT", "REJECTED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_EDITABLE",
      "Only draft or rejected Creator Products can be updated from PitchPrint.",
      409,
    );
  }
  const projectId = cleanProjectId(input.projectId);
  const previewUrls = cleanPreviewUrls(input);
  const previewUrl = previewUrls[0] || existing.previewUrl || null;
  const variantSelections = cleanDesignVariantSelections(
    input.variantSelections,
    productBaseVariants(existing),
  );
  if (!variantSelections.length) {
    throw new DomainError(
      "DESIGN_VARIANT_SELECTION_REQUIRED",
      "Select at least one size and quantity.",
      422,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      pitchprintProjectId: projectId,
      pitchprintDesignId:
        cleanPitchPrintDesignId(input.designId) ||
        existing.pitchprintDesignId,
      previewUrl,
      previewUrls: safeJson(previewUrls),
      designVariantSelectionsJson: safeJson(variantSelections),
      status: existing.status,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.pitchprint_saved",
      entityType: "CreatorProduct",
      entityId: existing.id,
      afterJson: safeJson({
        creatorId: creator.id,
        projectId,
        previewCount: previewUrls.length,
        selectedVariantCount: variantSelections.length,
        status: "DRAFT",
      }),
    },
  });
  if (database === db) {
    await createAdminNotification({
      shop,
      type: "CREATOR_PRODUCT_SUBMITTED",
      title: "Creator product submitted",
      message: `${creator.handle || "A creator"} submitted "${updated.title}" for review.`,
      entityType: "CreatorProduct",
      entityId: updated.id,
      actionUrl: "/app/creator-products",
      metadata: { creatorId: creator.id, creatorProductId: updated.id },
    });
  }
  return updated;
}

export async function submitCreatorProductForReview(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!["DRAFT", "REJECTED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_SUBMITTABLE",
      "Only draft or rejected Creator Products can be submitted.",
      409,
    );
  }
  validateCompletableCreatorProduct(existing);
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "PENDING",
      submittedAt: new Date(),
      rejectedAt: null,
      rejectionReason: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.submitted",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ creatorId: creator.id, status: "PENDING" }),
    },
  });
  return updated;
}

async function creatorProductHistoryCount(
  shop: string,
  creatorProductId: string,
  database: CreatorProductDb,
) {
  const [sales, orderItems] = await Promise.all([
    database.creatorSale?.count({
      where: {
        shop,
        creatorProductId,
      },
    }) ?? 0,
    database.creatorOrderItem?.count({
      where: {
        shop,
        creatorProductId,
      },
    }) ?? 0,
  ]);
  return sales + orderItems;
}

export async function updateCreatorProductDetailsForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  input: UpdateCreatorProductDetailsInput,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status === "PENDING") {
    throw new DomainError(
      "PRODUCT_UNDER_REVIEW",
      "Details are locked while this design is under review.",
      409,
    );
  }
  const title = cleanCreatorProductTitle(input.title);
  const description = cleanCreatorProductDescription(input.description);
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      title,
      description,
      status: existing.status,
      pitchprintProjectId: existing.pitchprintProjectId,
      pitchprintDesignId: existing.pitchprintDesignId,
      shopifyProductId: existing.shopifyProductId,
      creatorId: existing.creatorId,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.details_updated",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({
        title: existing.title,
        description: existing.description,
        status: existing.status,
      }),
      afterJson: safeJson({
        title: updated.title,
        description: updated.description,
        status: updated.status,
      }),
    },
  });
  return updated;
}

export async function deleteCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status === "PUBLISHED") {
    throw new DomainError(
      "PUBLISHED_REQUIRES_ARCHIVE",
      "Published designs must be archived instead of deleted.",
      409,
    );
  }
  if (existing.status === "PENDING") {
    throw new DomainError(
      "PRODUCT_UNDER_REVIEW",
      "Withdraw this design from review before deleting it.",
      409,
    );
  }
  const hasHistory = (await creatorProductHistoryCount(shop, existing.id, database)) > 0;
  if (hasHistory || existing.status === "ARCHIVED") {
    throw new DomainError(
      "PRODUCT_HAS_ORDER_HISTORY",
      "Designs with order or sales history cannot be permanently deleted.",
      409,
    );
  }
  if (!["DRAFT", "REJECTED"].includes(existing.status)) {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "This design cannot be deleted.",
      409,
    );
  }
  if (typeof database.creatorProduct.delete !== "function") {
    throw new DomainError(
      "DELETE_UNAVAILABLE",
      "Design delete is temporarily unavailable.",
      500,
    );
  }
  const deleted = await database.creatorProduct.delete({
    where: { id: existing.id },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.deleted",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({
        creatorId: creator.id,
        status: existing.status,
        hasHistory: false,
      }),
    },
  });
  return deleted;
}

export async function archiveCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PUBLISHED") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only published designs can be archived.",
      409,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "ARCHIVED",
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.archived",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "ARCHIVED" }),
    },
  });
  return updated;
}

export async function withdrawCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PENDING") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only pending designs can be withdrawn.",
      409,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "DRAFT",
      submittedAt: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.withdrawn",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "DRAFT" }),
    },
  });
  return updated;
}

export async function restoreCreatorProductToDraftForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "ARCHIVED") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only archived designs can be restored.",
      409,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "DRAFT",
      publishedAt: null,
      shopifyPublishedAt: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.restored_to_draft",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "DRAFT" }),
    },
  });
  return updated;
}

export async function listCreatorProductsForAdmin(
  shop: string,
  status: string | null,
  database: CreatorProductDb = db,
): Promise<
  Array<
    CreatorProductRecord & {
      creator: {
        id: string;
        displayName: string;
        handle: string;
        customerId: string;
      };
    }
  >
> {
  const allowed = ["PENDING", "PUBLISHED", "REJECTED", "DRAFT", "ARCHIVED"];
  const normalized = status && allowed.includes(status) ? status : null;
  return database.creatorProduct.findMany({
    where: {
      shop,
      ...(normalized ? { status: normalized } : {}),
    },
    include: {
      creator: {
        select: {
          id: true,
          displayName: true,
          handle: true,
          customerId: true,
        },
      },
    },
    orderBy: [{ submittedAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  } as unknown) as Promise<
    Array<
      CreatorProductRecord & {
        creator: {
          id: string;
          displayName: string;
          handle: string;
          customerId: string;
        };
      }
    >
  >;
}

export async function moderateCreatorProductAsAdmin(
  shop: string,
  adminId: string | null,
  input: AdminCreatorProductDecisionInput,
  clientOrDatabase: ShopifyGraphqlClient | CreatorProductDb = db,
  maybeDatabase?: CreatorProductDb,
) {
  const hasClient =
    typeof (clientOrDatabase as ShopifyGraphqlClient).request === "function";
  const database =
    ((hasClient ? maybeDatabase : clientOrDatabase) as CreatorProductDb | undefined) ||
    db;
  const creatorProductId =
    typeof input.creatorProductId === "string" ? input.creatorProductId : "";
  const decision =
    typeof input.decision === "string" ? input.decision.toUpperCase() : "";
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PENDING") {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_PENDING",
      "Only pending Creator Products can be reviewed.",
      409,
    );
  }
  validateCompletableCreatorProduct(existing);
  if (decision === "PUBLISHED") {
    const updated = await database.creatorProduct.update({
      where: { id: existing.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
      },
    });
    await database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.approved",
        entityType: "CreatorProduct",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "PUBLISHED" }),
      },
    });
    return updated;
  }
  if (decision === "REJECTED") {
    const rejectionReason = cleanRejectionReason(input.rejectionReason);
    if (!rejectionReason) {
      throw new DomainError(
        "REJECTION_REASON_REQUIRED",
        "Enter a rejection reason.",
        422,
      );
    }
    const updated = await database.creatorProduct.update({
      where: { id: existing.id },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectionReason,
      },
    });
    await database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.rejected",
        entityType: "CreatorProduct",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "REJECTED", reasonPresent: true }),
      },
    });
    return updated;
  }
  throw new DomainError(
    "INVALID_DECISION",
    "Choose approve or reject.",
    400,
  );
}

export async function listPublishedCreatorProductsForHandle(
  shop: string,
  creatorHandle: string,
  database: CreatorProductDb = db,
) {
  const collection = await getPublicCreatorCollection(
    shop,
    creatorHandle,
    database as unknown as Parameters<typeof getPublicCreatorCollection>[2],
  );
  const creator = collection.creator;
  const products = await database.creatorProduct.findMany({
    where: {
      shop,
      creatorId: collection.creatorId,
      status: "PUBLISHED",
    },
    orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  } as unknown);
  return { collection, creator, products };
}

export async function getPublishedCreatorProduct(
  shop: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const product = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      status: "PUBLISHED",
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  return product;
}

export async function getPublishedCreatorProductForHandle(
  shop: string,
  creatorHandle: string,
  creatorProductId: string,
  client?: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
): Promise<PublicCreatorProduct> {
  const collection = await getPublicCreatorCollection(
    shop,
    creatorHandle,
    database as unknown as Parameters<typeof getPublicCreatorCollection>[2],
  );
  const creator = collection.creator;
  const product = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: collection.creatorId,
      status: "PUBLISHED",
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  return {
    ...product,
    creator,
    collection,
    ...(client
      ? { baseProduct: await publicBaseProduct(product.shopifyProductId, client) }
      : {}),
  };
}

export async function publicCreatorProductDetail(
  shop: string,
  creatorHandle: string,
  creatorProductId: string,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  return getPublishedCreatorProductForHandle(
    shop,
    creatorHandle,
    creatorProductId,
    client,
    database,
  );
}

export async function publicCreatorCollection(
  shop: string,
  creatorHandle: string,
  client?: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  const result = await listPublishedCreatorProductsForHandle(
    shop,
    creatorHandle,
    database,
  );
  if (!client) return result;
  const bases = new Map<string, PublicCreatorProductBase>();
  for (const product of result.products) {
    if (!bases.has(product.shopifyProductId)) {
      bases.set(
        product.shopifyProductId,
        await publicBaseProduct(product.shopifyProductId, client),
      );
    }
  }
  return {
    collection: result.collection,
    creator: result.creator,
    products: result.products.map((product) => ({
      ...product,
      baseProduct: bases.get(product.shopifyProductId),
    })),
  };
}

export async function prepareCreatorProductCart(
  shop: string,
  input: PrepareCreatorProductCartInput,
  client: ShopifyGraphqlClient,
  cloner: PitchPrintProjectCloner = clonePitchPrintProject,
  database: CreatorProductDb = db,
) {
  const creatorHandle =
    typeof input.publicHandle === "string"
      ? input.publicHandle.trim()
      : typeof input.creatorHandle === "string"
        ? input.creatorHandle.trim()
        : "";
  if (!creatorHandle) {
    throw new DomainError(
      "CREATOR_HANDLE_REQUIRED",
      "Creator product URL is invalid.",
      400,
    );
  }
  const creatorProductId = cleanCreatorProductId(input.creatorProductId);
  const selectedVariantKey = cleanVariantSelection(input.selectedVariantId);
  const quantity = cleanQuantity(input.quantity);
  const product = await getPublishedCreatorProductForHandle(
    shop,
    creatorHandle,
    creatorProductId,
    client,
    database,
  );
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_MISSING",
      "This creator design is not ready for purchase.",
      409,
    );
  }
  const variant = product.baseProduct?.variants.find(
    (item) =>
      item.graphqlId === selectedVariantKey ||
      item.id === selectedVariantKey ||
      item.numericId === selectedVariantKey ||
      String(item.cartId) === selectedVariantKey,
  );
  if (!variant) {
    throw new DomainError(
      "INVALID_VARIANT",
      "Choose a valid option for this product.",
      422,
    );
  }
  if (!variant.availableForSale) {
    throw new DomainError(
      "VARIANT_UNAVAILABLE",
      "Choose an available option for this product.",
      409,
    );
  }
  if (!/^\d+$/.test(variant.cartId)) {
    throw new DomainError(
      "INVALID_VARIANT",
      "Choose an available option for this product.",
      409,
    );
  }
  const orderProjectId = await preparePitchPrintOrderProject(
    product.pitchprintProjectId,
    cloner,
  );
  const previewUrl = creatorCartPreviewUrl(product);
  let attribution: string;
  try {
    attribution = signCreatorAttribution({
      creatorProductId: product.id,
      creatorId: product.creatorId,
      creatorCollectionId: product.collection.id,
      baseProductId: product.shopifyProductId,
      baseVariantId: variant.graphqlId,
      pitchprintProjectId: orderProjectId,
    });
  } catch {
    throw new DomainError(
      "ATTRIBUTION_SIGNING_FAILED",
      "This creator design is temporarily unavailable.",
      500,
    );
  }
  return {
    variant: {
      graphqlId: variant.graphqlId,
      cartId: variant.cartId,
    },
    variantId: variant.cartId,
    cartVariantId: variant.cartId,
    shopifyVariantId: variant.graphqlId,
    quantity,
    properties: {
      _pitchprint: orderProjectId,
      _creator_product_id: product.id,
      _creator_id: product.creatorId,
      _creator_collection_id: product.collection.id,
      _base_product_id: product.shopifyProductId,
      _base_variant_id: variant.graphqlId,
      ...(previewUrl ? { _creator_preview_url: previewUrl } : {}),
      _customhouse_attribution: attribution,
      _customhouse_creator_handle: product.collection.publicHandle,
      "Creator Design": product.title,
      "Creator": product.creator.displayName,
    },
    creatorProduct: {
      id: product.id,
      title: product.title,
      creatorId: product.creatorId,
      masterPitchPrintProjectId: product.pitchprintProjectId,
    },
  };
}

export async function prepareNativeCreatorProductCart(
  shop: string,
  input: PrepareNativeCreatorProductCartInput,
  client: ShopifyGraphqlClient,
  cloner: PitchPrintProjectCloner = clonePitchPrintProject,
  database: CreatorProductDb = db,
) {
  const shopifyProductId = cleanProductGidOrNumeric(input.shopifyProductId);
  const selectedVariantId = cleanVariantGidOrNumeric(input.selectedVariantId);
  const quantity = cleanQuantity(input.quantity);
  const product = await database.creatorProduct.findFirst({
    where: {
      shop,
      publishedShopifyProductId: shopifyProductId,
      status: "PUBLISHED",
      creator: { status: "APPROVED" },
    },
  } as unknown);
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "This creator design is not ready for purchase.",
      409,
    );
  }
  await verifyNativeVariant(client, shopifyProductId, selectedVariantId);
  const collection = await getCreatorCollectionByCreatorId(
    shop,
    product.creatorId,
    database as unknown as Parameters<typeof getCreatorCollectionByCreatorId>[2],
  );
  if (!collection || collection.status !== "ACTIVE") {
    throw new DomainError(
      "COLLECTION_NOT_FOUND",
      "Creator collection not found.",
      404,
    );
  }
  const orderProjectId = await cloner(product.pitchprintProjectId);
  const baseVariantId = baseVariantForPublishedVariant(product, selectedVariantId);
  return {
    variantId: numericVariantId(selectedVariantId),
    shopifyVariantId: selectedVariantId,
    quantity,
    properties: {
      _pitchprint: orderProjectId,
      _creator_product_id: product.id,
      _creator_id: product.creatorId,
      _creator_collection_id: collection.id,
      _customhouse_creator_handle: collection.publicHandle,
      _base_product_id: product.shopifyProductId,
      ...(baseVariantId ? { _base_variant_id: baseVariantId } : {}),
    },
    creatorProduct: {
      id: product.id,
      title: product.title,
      creatorId: product.creatorId,
      masterPitchPrintProjectId: product.pitchprintProjectId,
      nativeShopifyProductId: shopifyProductId,
    },
  };
}

export async function listCreatorProductsForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const collection =
    "marketplaceCollection" in creator && creator.marketplaceCollection
      ? creator.marketplaceCollection
      : await getCreatorCollectionByCreatorId(
          shop,
          creator.id,
          database as unknown as Parameters<typeof getCreatorCollectionByCreatorId>[2],
        );
  const products = await database.creatorProduct.findMany({
    where: {
      shop,
      creatorId: creator.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  return products.map((product) => ({
    ...product,
    creatorHandle: collection?.publicHandle || null,
    collectionUrl: getCreatorCollectionStorefrontUrl(collection),
    storefrontCollectionUrl: getCreatorCollectionStorefrontUrl(collection),
    publicProductUrl:
      getCreatorProductStorefrontUrl(collection, product) ||
      `/apps/customhouse/design/${encodeURIComponent(product.id)}`,
    storefrontProductUrl: getCreatorProductStorefrontUrl(collection, product),
  }));
}

export async function getCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const product = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  return product;
}
