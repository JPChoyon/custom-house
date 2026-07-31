import type { CreatorStatus } from "@prisma/client";
import db from "../db.server";
import {
  collectionTitle,
  CREATOR_TAGS,
  DomainError,
  safeJson,
  slugify,
  statusTags,
} from "./domain";
import { normalizeCustomerGid } from "./helium-sync.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";
import {
  validateCreatorApplication,
  type CreatorApplicationInput,
} from "./creator-application";
import {
  canRunPreviewMutation,
  customerMutationDecision,
  isPreviewRuntime,
} from "./environment-safety.server";

function requireCustomerMutationAllowed() {
  const decision = customerMutationDecision();
  if (!decision.allowed) {
    throw new DomainError(
      decision.reason,
      "Customer changes are disabled in this environment.",
      403,
    );
  }
}

export async function createApplication(
  shop: string,
  customerId: string,
  input: CreatorApplicationInput,
  client: ShopifyGraphqlClient,
) {
  requireCustomerMutationAllowed();
  customerId = normalizeCustomerGid(customerId);
  const value = validateCreatorApplication(input);
  const config = await db.shopConfig.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  if (!config.creatorApplicationsEnabled) throw new DomainError("APPLICATIONS_DISABLED", "Creator applications are currently unavailable.", 503);
  const existing = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
    include: { applications: { where: { status: "PENDING" }, take: 1 } },
  });
  if (existing?.applications.length)
    throw new DomainError(
      "DUPLICATE_APPLICATION",
      "An active creator application already exists.",
      409,
    );
  if (existing?.status === "APPROVED" || existing?.status === "SUSPENDED")
    throw new DomainError(
      "APPLICATION_NOT_ALLOWED",
      "This creator account cannot submit another application.",
      409,
    );
  if (
    existing?.status === "REJECTED" &&
    !config.allowReapplicationAfterRejection
  )
    throw new DomainError(
      "REAPPLICATION_DISABLED",
      "Reapplication is not currently enabled.",
      409,
    );
  const customer = await client.request<{
    customer: { tags: string[] } | null;
  }>(
    `#graphql query ApplicationCustomer($id: ID!) { customer(id: $id) { tags } }`,
    { id: customerId },
  );
  if (!customer.customer)
    throw new DomainError(
      "CUSTOMER_NOT_FOUND",
      "The Shopify customer account could not be verified.",
      409,
    );
  const tagResult = await client.request<{
    customerUpdate: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation ApplicationTags($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { message } } }`,
    {
      input: {
        id: customerId,
        tags: statusTags(customer.customer.tags, "PENDING"),
      },
    },
  );
  throwUserErrors(
    tagResult.customerUpdate.userErrors,
    "Customer application tag sync",
  );
  let handle = slugify(value.displayName),
    suffix = 2;
  while (
    await db.creator.findFirst({ where: { shop, handle, NOT: { customerId } } })
  )
    handle = `${slugify(value.displayName)}-${suffix++}`;
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${shop}:${customerId}`}))`;
    const pending = await tx.creatorApplication.findFirst({ where: { shop, creator: { customerId }, status: "PENDING" }, select: { id: true } });
    if (pending) throw new DomainError("DUPLICATE_APPLICATION", "An active creator application already exists.", 409);
    const common = {
      displayName: value.displayName,
      handle,
      bio: value.bio,
      portfolioUrl: value.portfolioUrl,
      socialLinksJson: safeJson(value.socialLinks),
      profileImageUrl: value.profileImageUrl,
      legalName: value.legalName,
      country: value.country,
      city: value.city,
      applicationSource: "CUSTOM_APP" as const,
      statusAuthority: "CUSTOM_APP" as const,
      status: "PENDING" as const,
      rejectionReason: null,
    };
    const creator = await tx.creator.upsert({
      where: { shop_customerId: { shop, customerId } },
      update: common,
      create: { shop, customerId, ...common },
    });
    const application = await tx.creatorApplication.create({
      data: {
        shop,
        creatorId: creator.id,
        answersJson: "{}",
        legalName: value.legalName,
        displayName: value.displayName,
        country: value.country,
        city: value.city,
        bio: value.bio,
        portfolioUrl: value.portfolioUrl,
        socialLinksJson: safeJson(value.socialLinks),
        profileImageUrl: value.profileImageUrl,
        message: value.message,
        termsAcceptedAt: value.termsAcceptedAt,
        source: "CUSTOM_APP",
      },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "CUSTOMER",
        actorId: customerId,
        action: "application.created",
        entityType: "CreatorApplication",
        entityId: application.id,
        afterJson: safeJson({ source: "CUSTOM_APP", status: "PENDING" }),
      },
    });
    return { creator, application };
  });
  return updated;
}

export async function changeCreatorStatus(
  shop: string,
  creatorId: string,
  next: CreatorStatus,
  client: ShopifyGraphqlClient,
  reason?: string,
) {
  requireCustomerMutationAllowed();
  const creator = await db.creator.findFirst({
    where: { id: creatorId, shop },
  });
  if (!creator) throw new DomainError("NOT_FOUND", "Creator not found.", 404);
  if (next === "APPROVED") await ensureCreatorCollection(shop, creator.id, client);
  const customer = await client.request<{
    customer: { id: string; tags: string[] } | null;
  }>(`#graphql query($id: ID!) { customer(id: $id) { id tags } }`, {
    id: creator.customerId,
  });
  if (!customer.customer)
    throw new DomainError(
      "CUSTOMER_NOT_FOUND",
      "The Shopify customer no longer exists.",
      409,
    );
  const desiredTags = statusTags(customer.customer.tags, next);
  const creatorTagSet = new Set(Object.values(CREATOR_TAGS));
  const remove = customer.customer.tags.filter((tag) => creatorTagSet.has(tag as typeof CREATOR_TAGS.applicant) && !desiredTags.includes(tag));
  const add = desiredTags.filter((tag) => !customer.customer!.tags.includes(tag));
  if (remove.length) { const result = await client.request<{ tagsRemove: { userErrors: Array<{ message: string }> } }>(`#graphql mutation RemoveCreatorTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: creator.customerId, tags: remove }); throwUserErrors(result.tagsRemove.userErrors, "Customer tag removal"); }
  if (add.length) { const result = await client.request<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(`#graphql mutation AddCreatorTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: creator.customerId, tags: add }); throwUserErrors(result.tagsAdd.userErrors, "Customer tag addition"); }
  if (next === "SUSPENDED" || (next === "APPROVED" && creator.status === "SUSPENDED")) {
    const { setDesignerCreatorAvailability } = await import(
      "./designer-publishing.server"
    );
    await setDesignerCreatorAvailability(
      shop,
      creator.id,
      next === "APPROVED",
      client,
    );
  }
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const updated = await tx.creator.update({
      where: { id: creator.id },
      data: {
        status: next,
        statusAuthority: "CUSTOM_APP",
        externalSyncConflict: false,
        approvedAt: next === "APPROVED" ? now : creator.approvedAt,
        rejectedAt: next === "REJECTED" ? now : null,
        suspendedAt: next === "SUSPENDED" ? now : null,
        rejectionReason: next === "REJECTED" ? reason : null,
        suspensionReason: next === "SUSPENDED" ? reason : null,
      },
    });
    if (next === "APPROVED" || next === "REJECTED")
      await tx.creatorApplication.updateMany({
        where: { creatorId, status: "PENDING" },
        data: { status: next, reviewerNote: reason, reviewedAt: now },
      });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "ADMIN",
        action: `creator.${next.toLowerCase()}`,
        entityType: "Creator",
        entityId: creatorId,
        beforeJson: safeJson({ status: creator.status }),
        afterJson: safeJson({ status: next, reason }),
      },
    });
    return updated;
  });
  if (next === "APPROVED") {
    try { await syncCreatorProfileMetaobject(shop, creator.id, client); }
    catch { await db.auditLog.create({ data: { shop, actorType: "SYSTEM", action: "creator.metaobject_sync_warning", entityType: "Creator", entityId: creator.id, afterJson: safeJson({ recoverable: true }) } }); }
  }
  return updated;
}

export async function syncCreatorProfileMetaobject(shop: string, creatorId: string, client: ShopifyGraphqlClient) {
  const [creator, config] = await Promise.all([db.creator.findFirst({ where: { id: creatorId, shop } }), db.shopConfig.findUnique({ where: { shop } })]);
  if (!creator || !config?.creatorProfileMetaobjectType || !config.creatorProfileFieldMapJson) return null;
  let mapping: Record<string, string>;
  try { mapping = JSON.parse(config.creatorProfileFieldMapJson) as Record<string, string>; } catch { throw new DomainError("INVALID_METAOBJECT_MAPPING", "Creator Profile mapping is invalid.", 422); }
  const collectionUrl = creator.collectionId ? `/collections/${creator.handle}-${slugify(config.collectionHandleSuffix)}` : "";
  const values: Record<string, string | null> = { displayName: creator.displayName, biography: creator.bio, profileImage: creator.profileImageUrl, portfolioUrl: creator.portfolioUrl, socialLinks: creator.socialLinksJson, creatorHandle: creator.handle, collectionUrl, creatorStatus: creator.status };
  const fields = Object.entries(mapping).filter(([source, key]) => values[source] && /^[a-z][a-z0-9_]*$/.test(key)).map(([source, key]) => ({ key, value: values[source]! }));
  if (!fields.length) return null;
  const result = await client.request<{ metaobjectUpsert: { metaobject: { id: string } | null; userErrors: Array<{ message: string }> } }>(
    `#graphql mutation CreatorProfileUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) { metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { message } } }`,
    { handle: { type: config.creatorProfileMetaobjectType, handle: creator.handle }, metaobject: { fields } },
  );
  throwUserErrors(result.metaobjectUpsert.userErrors, "Creator Profile synchronization");
  const id = result.metaobjectUpsert.metaobject?.id; if (id) await db.creator.update({ where: { id: creator.id }, data: { creatorProfileMetaobjectId: id } });
  return id ?? null;
}

export async function ensureCreatorCollection(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
) {
  const [creator, config] = await Promise.all([
    db.creator.findFirst({ where: { id: creatorId, shop } }),
    db.shopConfig.findUnique({ where: { shop } }),
  ]);
  if (!creator) return null;
  let collectionId = creator.collectionId;
  if (
    isPreviewRuntime() &&
    (!collectionId ||
      !canRunPreviewMutation({
        shop,
        resourceType: "collection",
        resourceId: collectionId,
      }))
  ) {
    throw new DomainError(
      "PREVIEW_COLLECTION_MUTATION_DENIED",
      "A designated Preview creator collection is required.",
      403,
    );
  }
  if (!collectionId && config?.automaticCollectionCreationEnabled === false) return null;
  const title = collectionTitle(
    config?.collectionTitleTemplate ?? "{creatorName} Designs",
    creator.displayName,
  );
  const handle = `${creator.handle}-${slugify(config?.collectionHandleSuffix ?? "designs")}`;
  if (!collectionId) {
  const result = await client.request<{
    collectionCreate: {
      collection: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation CreatorCollection($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`,
    { input: { title, handle } },
  );
  throwUserErrors(
    result.collectionCreate.userErrors,
    "Creator collection creation",
  );
  if (!result.collectionCreate.collection)
    throw new DomainError(
      "COLLECTION_CREATE_FAILED",
      "Creator collection could not be created.",
      502,
    );
  collectionId = result.collectionCreate.collection.id;
  await db.creator.update({
    where: { id: creator.id },
    data: { collectionId },
  });
  }
  if (config?.onlineStorePublicationId && collectionId && !isPreviewRuntime()) {
    const publication = await client.request<{ publishablePublish: { userErrors: Array<{ message: string }> } }>(
      `#graphql mutation PublishCreatorCollection($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
      { id: collectionId, input: [{ publicationId: config.onlineStorePublicationId }] },
    );
    throwUserErrors(publication.publishablePublish.userErrors, "Creator collection publication");
  }
  return collectionId;
}

export const defaultCreatorTags = Object.values(CREATOR_TAGS);
