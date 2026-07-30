import { randomUUID } from "node:crypto";
import db from "../db.server";
import { ensureCreatorCollection } from "./creator.server";
import { DomainError, safeJson, slugify } from "./domain";
import { getDesignerConfig } from "./designer-config.server";
import {
  canCreatorPublish,
  designerPublishKey,
  duplicateVariantsToDelete,
  fixedProductTags,
  type VariantShape,
} from "./designer-publishing";
import {
  requireApprovedCreator,
  verifyDesignerProduct,
} from "./designer-session.server";
import { normalizeCustomerGid } from "./helium-sync.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";
import { validateDesignJson } from "./designer-validation";
import {
  parseVariantMapping,
  verifyGlobalZakekeProduct,
} from "./zakeke/zakeke-products.server";

type Errors = Array<{ message: string }>;

async function setProductStatus(
  client: ShopifyGraphqlClient,
  productId: string,
  status: "ACTIVE" | "DRAFT",
) {
  const result = await client.request<{
    productUpdate: { userErrors: Errors };
  }>(
    `#graphql mutation DesignerProductStatus($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { message } }
    }`,
    { product: { id: productId, status } },
  );
  throwUserErrors(result.productUpdate.userErrors, "Designer product status");
}

async function setPublication(
  client: ShopifyGraphqlClient,
  id: string,
  publicationId: string,
  publish: boolean,
) {
  const field = publish ? "publishablePublish" : "publishableUnpublish";
  const result = await client.request<Record<string, { userErrors: Errors }>>(
    `#graphql mutation DesignerPublication($id: ID!, $input: [PublicationInput!]!) {
      ${field}(id: $id, input: $input) { userErrors { message } }
    }`,
    { id, input: [{ publicationId }] },
  );
  throwUserErrors(result[field].userErrors, "Designer publication");
}

async function createOrReuseProduct(
  client: ShopifyGraphqlClient,
  input: {
    currentProductId: string | null;
    sourceProductId: string;
    title: string;
  },
) {
  if (input.currentProductId) {
    await setProductStatus(client, input.currentProductId, "DRAFT");
    return input.currentProductId;
  }
  const result = await client.request<{
    productDuplicate: {
      newProduct: { id: string } | null;
      userErrors: Errors;
    };
  }>(
    `#graphql mutation DuplicateDesignerProduct(
      $productId: ID!,
      $title: String!
    ) {
      productDuplicate(
        productId: $productId,
        newTitle: $title,
        newStatus: DRAFT,
        includeImages: false
      ) {
        newProduct { id }
        userErrors { message }
      }
    }`,
    { productId: input.sourceProductId, title: input.title },
  );
  throwUserErrors(result.productDuplicate.userErrors, "Designer product duplication");
  const productId = result.productDuplicate.newProduct?.id;
  if (!productId) {
    throw new Error("Designer product duplication failed.");
  }
  return productId;
}

async function waitForDesignerMedia(
  client: ShopifyGraphqlClient,
  productId: string,
  alt: string,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await client.request<{
      product: {
        media: { nodes: Array<{ alt: string | null; status: string }> };
      } | null;
    }>(
      `#graphql query DesignerMediaStatus($id: ID!) {
        product(id: $id) {
          media(first: 50) { nodes { alt status } }
        }
      }`,
      { id: productId },
    );
    const media = result.product?.media.nodes.find((item) => item.alt === alt);
    if (media?.status === "READY") return;
    if (media?.status === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new DomainError(
    "DESIGN_MEDIA_PROCESSING",
    "The product preview is still processing. Retry publishing shortly.",
    503,
  );
}

async function configureFixedProduct(
  client: ShopifyGraphqlClient,
  input: {
    productId: string;
    title: string;
    sourceTags: string[];
    sourceVariants: VariantShape[];
    allowedVariantIds: readonly string[];
    previewUrl: string;
    creatorId: string;
    designId: string;
    baseProductId: string;
    collectionId: string;
    publicationId?: string | null;
    sourceZakekeDesignId?: string | null;
    designVersion?: number;
  },
) {
  const updated = await client.request<{
    productUpdate: { userErrors: Errors };
  }>(
    `#graphql mutation ConfigureDesignerProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { message } }
    }`,
    {
      product: {
        id: input.productId,
        title: input.title,
        status: "DRAFT",
        tags: fixedProductTags(input.sourceTags),
      },
    },
  );
  throwUserErrors(updated.productUpdate.userErrors, "Designer product configuration");

  const metafields = [
    ["product_origin", "single_line_text_field", "creator"],
    ["design_mode", "single_line_text_field", "buy_only"],
    ["product_type", "single_line_text_field", "creator_fixed"],
    ["creator_id", "single_line_text_field", input.creatorId],
    ["creator_design_id", "single_line_text_field", input.designId],
    ["base_product_id", "single_line_text_field", input.baseProductId],
    ["design_locked", "boolean", "true"],
    ["design_version", "number_integer", String(input.designVersion ?? 1)],
    ...(input.sourceZakekeDesignId
      ? [
          [
            "zakeke_source_design_id",
            "single_line_text_field",
            input.sourceZakekeDesignId,
          ],
        ]
      : []),
  ].map(([key, type, value]) => ({
    ownerId: input.productId,
    namespace: "customhouse",
    key,
    type,
    value,
  }));
  const metafieldResult = await client.request<{
    metafieldsSet: { userErrors: Errors };
  }>(
    `#graphql mutation DesignerProductMetafields(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    { metafields },
  );
  throwUserErrors(
    metafieldResult.metafieldsSet.userErrors,
    "Designer product metafields",
  );

  const duplicate = await client.request<{
    product: {
      media: { nodes: Array<{ alt: string | null; status: string }> };
      variants: { nodes: VariantShape[] };
    } | null;
  }>(
    `#graphql query DesignerDuplicateState($id: ID!) {
      product(id: $id) {
        media(first: 50) { nodes { alt status } }
        variants(first: 100) {
          nodes { id selectedOptions { name value } }
        }
      }
    }`,
    { id: input.productId },
  );
  if (!duplicate.product) throw new Error("Designer product is unavailable.");
  const mediaAlt = `Custom House design ${input.designId}`;
  if (!duplicate.product.media.nodes.some((item) => item.alt === mediaAlt)) {
    const media = await client.request<{
      productUpdate: { userErrors: Errors };
    }>(
      `#graphql mutation DesignerProductMedia(
        $product: ProductUpdateInput!,
        $media: [CreateMediaInput!]!
      ) {
        productUpdate(product: $product, media: $media) {
          userErrors { message }
        }
      }`,
      {
        product: { id: input.productId },
        media: [
          {
            originalSource: input.previewUrl,
            mediaContentType: "IMAGE",
            alt: mediaAlt,
          },
        ],
      },
    );
    throwUserErrors(media.productUpdate.userErrors, "Designer preview image");
  }
  await waitForDesignerMedia(client, input.productId, mediaAlt);

  const deleteIds = duplicateVariantsToDelete(
    input.sourceVariants,
    input.allowedVariantIds,
    duplicate.product.variants.nodes,
  );
  if (deleteIds.length) {
    const deleted = await client.request<{
      productVariantsBulkDelete: { userErrors: Errors };
    }>(
      `#graphql mutation TrimDesignerVariants(
        $productId: ID!,
        $variantsIds: [ID!]!
      ) {
        productVariantsBulkDelete(
          productId: $productId,
          variantsIds: $variantsIds
        ) { userErrors { message } }
      }`,
      { productId: input.productId, variantsIds: deleteIds },
    );
    throwUserErrors(
      deleted.productVariantsBulkDelete.userErrors,
      "Designer variant selection",
    );
  }

  const membership = await client.request<{
    collectionAddProducts: { userErrors: Errors };
  }>(
    `#graphql mutation AddDesignerToCollection(
      $id: ID!,
      $products: [ID!]!
    ) {
      collectionAddProducts(id: $id, productIds: $products) {
        userErrors { message }
      }
    }`,
    { id: input.collectionId, products: [input.productId] },
  );
  throwUserErrors(
    membership.collectionAddProducts.userErrors,
    "Designer collection membership",
  );
  if (input.publicationId) {
    await setPublication(client, input.productId, input.publicationId, true);
    await setPublication(client, input.collectionId, input.publicationId, true);
  }
  await setProductStatus(client, input.productId, "ACTIVE");
}

async function synchronizeCreatorDesign(
  shop: string,
  designId: string,
  client: ShopifyGraphqlClient,
) {
  const design = await db.creatorDesign.findFirst({
    where: { id: designId, shop },
    include: { creator: true, designSession: true },
  });
  if (!design) {
    throw new DomainError("DESIGN_MISSING", "The creator design was not found.", 404);
  }
  if (
    !canCreatorPublish(
      design.creator.status,
      design.creator.suspendedAt,
    )
  ) {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can add designs to a collection.",
      403,
    );
  }
  let source: {
    id: string;
    title: string;
    tags: string[];
    variants: VariantShape[];
  };
  let allowedVariantIds: readonly string[];
  if (design.provider === "ZAKEKE") {
    if (!design.globalProductMappingId) {
      throw new DomainError(
        "ZAKEKE_MAPPING_MISSING",
        "The Zakeke product mapping is missing.",
        409,
      );
    }
    const mapping = await db.globalProductMapping.findFirst({
      where: {
        id: design.globalProductMappingId,
        shop,
        enabled: true,
        status: { in: ["TESTING", "ACTIVE"] },
      },
    });
    if (!mapping) {
      throw new DomainError(
        "ZAKEKE_MAPPING_MISSING",
        "The Zakeke product mapping is unavailable.",
        409,
      );
    }
    source = await verifyGlobalZakekeProduct(
      client,
      design.globalShopifyProductId,
    );
    allowedVariantIds = parseVariantMapping(
      mapping.variantMappingJson,
    ).variants
      .filter((variant) => variant.enabled !== false)
      .map((variant) => variant.shopifyVariantId);
  } else {
    const config = getDesignerConfig();
    source = await verifyDesignerProduct(
      client,
      config,
      design.globalShopifyProductId,
      design.designSession.shopifyVariantId,
    );
    allowedVariantIds = config.allowedVariantIds;
  }
  let productId = design.shopifyCreatorProductId;
  try {
    const collectionId = await ensureCreatorCollection(
      shop,
      design.creatorId,
      client,
    );
    if (!collectionId) {
      throw new DomainError(
        "COLLECTION_REQUIRED",
        "A creator collection is required before publishing.",
        409,
      );
    }
    productId = await createOrReuseProduct(client, {
      currentProductId: productId,
      sourceProductId: source.id,
      title: design.title,
    });
    if (productId !== design.shopifyCreatorProductId) {
      await db.creatorDesign.update({
        where: { id: design.id },
        data: { shopifyCreatorProductId: productId },
      });
    }
    const shopConfig = await db.shopConfig.findUnique({ where: { shop } });
    await configureFixedProduct(client, {
      productId,
      title: design.title,
      sourceTags: source.tags,
      sourceVariants: source.variants,
      allowedVariantIds,
      previewUrl: design.previewUrl,
      creatorId: design.creatorId,
      designId: design.id,
      baseProductId: design.globalShopifyProductId,
      collectionId,
      publicationId: shopConfig?.onlineStorePublicationId,
      sourceZakekeDesignId: design.sourceZakekeDesignId,
      designVersion: design.designVersion,
    });
    const now = new Date();
    return db.$transaction(async (tx) => {
      const updated = await tx.creatorDesign.update({
        where: { id: design.id },
        data: {
          shopifyCreatorProductId: productId,
          shopifyCollectionId: collectionId,
          status: "ACTIVE",
          syncStatus: "SYNCED",
          publishError: null,
          lastErrorCode: null,
          lastErrorReference: null,
          publishedAt: now,
        },
      });
      await tx.designSession.update({
        where: { id: design.designSessionId },
        data: { status: "PUBLISHED" },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: "CREATOR",
          actorId: design.creator.customerId,
          action:
            design.provider === "ZAKEKE"
              ? "zakeke_design.published"
              : "fabric_design.published",
          entityType: "CreatorDesign",
          entityId: design.id,
          afterJson: safeJson({ productId, collectionId }),
        },
      });
      return updated;
    });
  } catch {
    const referenceId = randomUUID();
    if (productId) {
      try {
        await setProductStatus(client, productId, "DRAFT");
      } catch {
        // The stored product ID makes the next retry idempotent.
      }
    }
    await db.creatorDesign.update({
      where: { id: design.id },
      data: {
        shopifyCreatorProductId: productId,
        status: "FAILED",
        syncStatus: "FAILED",
        publishError: "Shopify synchronization failed. Retry is available.",
        lastErrorCode: "SHOPIFY_DESIGN_SYNC_FAILED",
        lastErrorReference: referenceId,
      },
    });
    throw new DomainError(
      "DESIGN_PUBLISH_FAILED",
      "We could not publish this design. Please try again.",
      502,
    );
  }
}

export async function publishZakekeCreatorDesign(input: {
  shop: string;
  customerId: string;
  sessionId: string;
  sourceZakekeDesignId: string;
  title: string;
  description?: string;
  previewUrl: string;
  selectedAttributesJson: string;
  client: ShopifyGraphqlClient;
}) {
  const customerId = normalizeCustomerGid(input.customerId);
  const creator = await requireApprovedCreator(input.shop, customerId);
  const session = await db.designSession.findFirst({
    where: {
      id: input.sessionId,
      shop: input.shop,
      customerId,
      creatorId: creator.id,
      provider: "ZAKEKE",
      mode: "CREATOR_PUBLISH",
      zakekeDesignId: input.sourceZakekeDesignId,
    },
    include: { creatorDesign: true, globalProductMapping: true },
  });
  if (!session?.globalProductMapping) {
    throw new DomainError(
      "DESIGN_SESSION_MISSING",
      "The Zakeke designer session could not be found.",
      404,
    );
  }
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) {
    throw new DomainError(
      "DESIGN_TITLE_INVALID",
      "Enter a design title between 2 and 120 characters.",
      422,
    );
  }
  const description = input.description?.trim().slice(0, 2_000) || null;
  if (
    session.creatorDesign?.status === "ACTIVE" &&
    session.creatorDesign.syncStatus === "SYNCED"
  ) {
    return session.creatorDesign;
  }
  const compatibleVariantIds = parseVariantMapping(
    session.globalProductMapping.variantMappingJson,
  ).variants
    .filter((variant) => variant.enabled !== false)
    .map((variant) => variant.shopifyVariantId);
  const idempotencyKey = designerPublishKey(
    input.shop,
    creator.id,
    session.id,
  );
  const slug = `${slugify(title)}-${input.sourceZakekeDesignId
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-8)
    .toLowerCase()}`;
  let designId: string;
  if (session.creatorDesign) {
    const claimed = await db.creatorDesign.updateMany({
      where: {
        id: session.creatorDesign.id,
        syncStatus: { in: ["PENDING", "FAILED"] },
      },
      data: {
        title,
        description,
        slug,
        previewUrl: input.previewUrl,
        artworkUrl: input.previewUrl,
        sourceZakekeDesignId: input.sourceZakekeDesignId,
        selectedAttributesJson: input.selectedAttributesJson,
        compatibleVariantIdsJson: JSON.stringify(compatibleVariantIds),
        status: "PROCESSING",
        syncStatus: "SYNCING",
        publishError: null,
        lastErrorCode: null,
        lastErrorReference: null,
      },
    });
    if (claimed.count !== 1) {
      throw new DomainError(
        "DESIGN_PUBLISH_IN_PROGRESS",
        "This design is already being published.",
        409,
      );
    }
    designId = session.creatorDesign.id;
  } else {
    const design = await db.creatorDesign.create({
      data: {
        shop: input.shop,
        creatorId: creator.id,
        designSessionId: session.id,
        provider: "ZAKEKE",
        globalProductMappingId: session.globalProductMappingId,
        globalShopifyProductId: session.shopifyProductId,
        sourceZakekeDesignId: input.sourceZakekeDesignId,
        title,
        slug,
        description,
        previewUrl: input.previewUrl,
        artworkUrl: input.previewUrl,
        designJson: safeJson({
          provider: "ZAKEKE",
          designId: input.sourceZakekeDesignId,
        }),
        compatibleVariantIdsJson: JSON.stringify(compatibleVariantIds),
        selectedAttributesJson: input.selectedAttributesJson,
        status: "PROCESSING",
        syncStatus: "SYNCING",
        idempotencyKey,
      },
    });
    designId = design.id;
  }
  try {
    return await synchronizeCreatorDesign(
      input.shop,
      designId,
      input.client,
    );
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "DESIGN_PUBLISH_FAILED"
    ) {
      throw new DomainError(
        "ZAKEKE_DESIGN_SAVED_SYNC_FAILED",
        "Your design was saved, but we could not add it to your collection. Please try again.",
        502,
      );
    }
    throw error;
  }
}

export async function publishCreatorDesign(input: {
  shop: string;
  customerId: string;
  sessionId: string;
  title: string;
  client: ShopifyGraphqlClient;
}) {
  const customerId = normalizeCustomerGid(input.customerId);
  const creator = await requireApprovedCreator(input.shop, customerId);
  const session = await db.designSession.findFirst({
    where: {
      id: input.sessionId,
      shop: input.shop,
      customerId,
      creatorId: creator.id,
      mode: "CREATOR_PUBLISH",
    },
    include: { creatorDesign: true },
  });
  if (!session) {
    throw new DomainError(
      "DESIGN_SESSION_MISSING",
      "The design session could not be found.",
      404,
    );
  }
  validateDesignJson(session.designJson);
  if (!session.previewUrl || !session.artworkUrl) {
    throw new DomainError(
      "DESIGN_EXPORT_MISSING",
      "Save the draft before adding it to your collection.",
      409,
    );
  }
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) {
    throw new DomainError(
      "DESIGN_TITLE_INVALID",
      "Enter a design title between 2 and 120 characters.",
      422,
    );
  }
  if (
    session.creatorDesign?.status === "ACTIVE" &&
    session.creatorDesign.syncStatus === "SYNCED"
  ) {
    return session.creatorDesign;
  }
  if (session.creatorDesign?.syncStatus === "SYNCING") {
    throw new DomainError(
      "DESIGN_PUBLISH_IN_PROGRESS",
      "This design is already being published.",
      409,
    );
  }
  let designId: string;
  if (session.creatorDesign) {
    const claimed = await db.creatorDesign.updateMany({
      where: {
        id: session.creatorDesign.id,
        syncStatus: { in: ["PENDING", "FAILED"] },
      },
      data: {
        title,
        previewUrl: session.previewUrl,
        artworkUrl: session.artworkUrl,
        designJson: session.designJson,
        status: "DRAFT",
        syncStatus: "SYNCING",
        publishError: null,
      },
    });
    if (claimed.count !== 1) {
      throw new DomainError(
        "DESIGN_PUBLISH_IN_PROGRESS",
        "This design is already being published.",
        409,
      );
    }
    designId = session.creatorDesign.id;
  } else {
    try {
      const design = await db.creatorDesign.create({
        data: {
          shop: input.shop,
          creatorId: creator.id,
          designSessionId: session.id,
          globalShopifyProductId: session.shopifyProductId,
          title,
          previewUrl: session.previewUrl,
          artworkUrl: session.artworkUrl,
          designJson: session.designJson,
          idempotencyKey: designerPublishKey(input.shop, creator.id, session.id),
          syncStatus: "SYNCING",
        },
      });
      designId = design.id;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Unique constraint")) {
        throw new DomainError(
          "DESIGN_PUBLISH_IN_PROGRESS",
          "This design is already being published.",
          409,
        );
      }
      throw error;
    }
  }
  return synchronizeCreatorDesign(input.shop, designId, input.client);
}

export async function retryCreatorDesign(
  shop: string,
  designId: string,
  client: ShopifyGraphqlClient,
) {
  const claimed = await db.creatorDesign.updateMany({
    where: { id: designId, shop, syncStatus: "FAILED" },
    data: { status: "DRAFT", syncStatus: "SYNCING", publishError: null },
  });
  if (claimed.count !== 1) {
    throw new DomainError(
      "DESIGN_NOT_RETRYABLE",
      "Only failed designer synchronizations can be retried.",
      409,
    );
  }
  return synchronizeCreatorDesign(shop, designId, client);
}

export async function setDesignerCreatorAvailability(
  shop: string,
  creatorId: string,
  active: boolean,
  client: ShopifyGraphqlClient,
) {
  const [creator, config, designs] = await Promise.all([
    db.creator.findFirst({ where: { id: creatorId, shop } }),
    db.shopConfig.findUnique({ where: { shop } }),
    db.creatorDesign.findMany({
      where: active
        ? {
            shop,
            creatorId,
            status: "SUSPENDED",
            syncStatus: "HIDDEN",
            hiddenReason: "CREATOR_SUSPENDED",
            wasPublishedBeforeSuspension: true,
          }
        : { shop, creatorId, status: "ACTIVE", syncStatus: "SYNCED" },
    }),
  ]);
  if (!creator || !designs.length) return;
  for (const design of designs) {
    if (!design.shopifyCreatorProductId) continue;
    if (active) {
      if (config?.onlineStorePublicationId) {
        await setPublication(
          client,
          design.shopifyCreatorProductId,
          config.onlineStorePublicationId,
          true,
        );
      }
      await setProductStatus(client, design.shopifyCreatorProductId, "ACTIVE");
      await db.creatorDesign.update({
        where: { id: design.id },
        data: {
          status: "ACTIVE",
          syncStatus: "SYNCED",
          hiddenReason: null,
          wasPublishedBeforeSuspension: false,
        },
      });
    } else {
      await setProductStatus(client, design.shopifyCreatorProductId, "DRAFT");
      if (config?.onlineStorePublicationId) {
        await setPublication(
          client,
          design.shopifyCreatorProductId,
          config.onlineStorePublicationId,
          false,
        );
      }
      await db.creatorDesign.update({
        where: { id: design.id },
        data: {
          status: "SUSPENDED", syncStatus: "HIDDEN",
          hiddenReason: "CREATOR_SUSPENDED",
          wasPublishedBeforeSuspension: true,
        },
      });
    }
  }
  if (creator.collectionId && config?.onlineStorePublicationId) {
    await setPublication(
      client,
      creator.collectionId,
      config.onlineStorePublicationId,
      active,
    );
  }
}
