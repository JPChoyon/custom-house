import db from "../db.server";
import { DomainError, parseJsonList, slugify } from "./domain";
import { submissionKey } from "./idempotency.server";
import {
  ManualInkyBayProvider,
  type ManualDesignInput,
} from "./design-provider.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { normalizeCustomerGid } from "./helium-sync.server";
import { getZakekeFeatureFlags } from "./zakeke/zakeke-config.server";
import { canCreatorPublish } from "./designer-publishing";

export async function createSubmission(
  shop: string,
  customerId: string,
  input: ManualDesignInput,
  client: ShopifyGraphqlClient,
) {
  customerId = normalizeCustomerGid(customerId);
  const creator = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  if (!creator || !canCreatorPublish(creator.status, creator.suspendedAt))
    throw new DomainError(
      "NOT_APPROVED",
      "Only approved creators can submit designs.",
      403,
    );
  const config = await db.shopConfig.findUnique({ where: { shop } });
  const normalized = new ManualInkyBayProvider().normalize(
    input,
    parseJsonList(config?.inkybayAllowedHostsJson ?? "[]"),
  );
  const result = await client.request<{
    product: {
      origin: { value: string } | null;
      mode: { value: string } | null;
    } | null;
  }>(
    `#graphql query($id: ID!) { product(id: $id) { origin: metafield(namespace: "customhouse", key: "product_origin") { value } mode: metafield(namespace: "customhouse", key: "design_mode") { value } } }`,
    { id: normalized.baseProductId },
  );
  if (!result.product)
    throw new DomainError("PRODUCT_NOT_FOUND", "Base product not found.", 404);
  if (result.product.origin?.value !== "global")
    throw new DomainError(
      "NOT_GLOBAL",
      "Designs must start from a Global Product.",
      422,
    );
  if (result.product.mode?.value !== "customizable")
    throw new DomainError(
      "NOT_CUSTOMIZABLE",
      "This product is not customizable.",
      422,
    );
  const idempotencyKey = submissionKey(
    shop,
    creator.id,
    normalized.baseProductId,
    normalized.savedDesignUrl,
  );
  try {
    return await db.$transaction(async (tx) => {
      const submission = await tx.designSubmission.create({
        data: { shop, creatorId: creator.id, ...normalized, idempotencyKey },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: "CUSTOMER",
          actorId: customerId,
          action: "submission.created",
          entityType: "DesignSubmission",
          entityId: submission.id,
        },
      });
      return submission;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint"))
      throw new DomainError(
        "DUPLICATE_SUBMISSION",
        "This saved design was already submitted.",
        409,
      );
    throw error;
  }
}

export async function creatorDashboard(shop: string, customerId: string) {
  customerId = normalizeCustomerGid(customerId);
  const [creator, config] = await Promise.all([
    db.creator.findUnique({
      where: { shop_customerId: { shop, customerId } },
      include: {
        applications: { orderBy: { createdAt: "desc" }, take: 1 },
        submissions: { orderBy: { createdAt: "desc" }, take: 20 },
        creatorDesigns: {
          where: { provider: "ZAKEKE" },
          orderBy: { updatedAt: "desc" },
          take: 50,
          select: {
            id: true,
            title: true,
            status: true,
            syncStatus: true,
            previewUrl: true,
            shopifyCreatorProductId: true,
            updatedAt: true,
          },
        },
      },
    }),
    db.shopConfig.findUnique({
      where: { shop },
      select: { collectionHandleSuffix: true },
    }),
  ]);

  if (!creator) {
    return { state: "NOT_APPLIED" as const, creatorFound: false };
  }

  const collectionUrl = creator.collectionId
    ? `/collections/${creator.handle}-${slugify(config?.collectionHandleSuffix ?? "designs")}`
    : null;
  const publishedProducts = creator.submissions.filter(
    (submission) =>
      submission.status === "PUBLISHED" && submission.createdProductId,
  );
  const zakekeFlags = getZakekeFeatureFlags();
  const eligibleProducts =
    canCreatorPublish(creator.status, creator.suspendedAt) &&
    zakekeFlags.integration &&
    zakekeFlags.creatorPublishing
      ? await db.globalProductMapping.findMany({
          where: {
            shop,
            enabled: true,
            status: { in: ["TESTING", "ACTIVE"] },
          },
          select: {
            shopifyProductId: true,
            shopifyProductHandle: true,
            zakekeProductCode: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 20,
        })
      : [];
  const activeZakekeDesigns = creator.creatorDesigns.filter(
    (design) =>
      design.status === "ACTIVE" && design.syncStatus === "SYNCED",
  );

  return {
    state: creator.externalSyncConflict ? "SYNC_CONFLICT" as const : creator.status,
    creatorFound: true,
    displayName: creator.displayName,
    bio: creator.bio,
    portfolioUrl: creator.portfolioUrl,
    profileImageUrl: creator.profileImageUrl,
    handle: creator.handle,
    status: creator.status,
    collectionUrl,
    rejectionReason: creator.rejectionReason,
    suspensionReason: creator.suspensionReason,
    applicationStatus: creator.applications[0]?.status ?? null,
    overview: {
      totalSales: null,
      totalEarnings: null,
      ordersCount: null,
      collectionsCount: creator.collectionId ? 1 : 0,
      publishedProductsCount:
        publishedProducts.length + activeZakekeDesigns.length,
    },
    topSellingProducts: [],
    submissions: creator.submissions.map(
      ({
        id,
        designName,
        status,
        previewUrl,
        createdAt,
        createdProductId,
      }) => ({
        id,
        designName,
        status,
        previewUrl,
        createdAt,
        createdProductId,
      }),
    ),
    zakeke: {
      publishingAvailable:
        canCreatorPublish(creator.status, creator.suspendedAt) &&
        zakekeFlags.integration &&
        zakekeFlags.creatorPublishing,
      eligibleProducts: eligibleProducts.map((mapping) => ({
        productId: mapping.shopifyProductId,
        productUrl: mapping.shopifyProductHandle
          ? `/products/${mapping.shopifyProductHandle}`
          : null,
        productCode: mapping.zakekeProductCode,
      })),
      designs: creator.creatorDesigns,
    },
  };
}
