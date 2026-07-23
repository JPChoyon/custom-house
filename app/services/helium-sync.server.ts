import db from "../db.server";
import { createHash } from "node:crypto";
import { safeJson, slugify } from "./domain";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import {
  creatorStatusFromTags,
  hasConflictingCreatorTags,
  normalizeCustomerGid,
  parseHeliumMetafieldMap,
  planHeliumSync,
  withHeliumCreatorFormTags,
  type HeliumCustomerInput,
  type HeliumField,
  type HeliumMetafieldMap,
} from "./helium-sync";
export {
  creatorStatusFromTags,
  loadWithLazySync,
  normalizeCustomerGid,
  parseHeliumMetafieldMap,
  planHeliumSync,
} from "./helium-sync";

type CustomerMetafield = {
  namespace: string;
  key: string;
  value: string;
  reference?: {
    image?: { url?: string };
    url?: string;
  } | null;
};

function mappedMetafieldQuery(map: HeliumMetafieldMap) {
  const entries = Object.values(map).filter((entry) => entry.enabled);
  const variableDefinitions = entries
    .flatMap((_, index) => [
      `$metafieldNamespace${index}: String!`,
      `$metafieldKey${index}: String!`,
    ])
    .join(", ");
  const selection = entries
    .map(
      (_, index) =>
        `metafield${index}: metafield(namespace: $metafieldNamespace${index}, key: $metafieldKey${index}) { namespace key value reference { ... on MediaImage { image { url } } ... on GenericFile { url } } }`,
    )
    .join("\n");
  const variables = Object.fromEntries(
    entries.flatMap((entry, index) => [
      [`metafieldNamespace${index}`, entry.namespace],
      [`metafieldKey${index}`, entry.key],
    ]),
  );
  return {
    variableDefinitions,
    selection,
    variables,
    values(customer: Record<string, unknown>): CustomerMetafield[] {
      return entries
        .map(
          (_, index) =>
            customer[`metafield${index}`] as CustomerMetafield | null,
        )
        .filter((value): value is CustomerMetafield => Boolean(value));
    },
  };
}

function snapshotHash(input: HeliumCustomerInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tags: [...input.tags].sort(),
        formIds: [...(input.formIds || [])].sort(),
        fields: input.fields || {},
      }),
    )
    .digest("hex");
}

function parseFormIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function customerFormIds(customer: Record<string, unknown>): string[] {
  const metafield = customer.creatorFormIds as { value?: unknown } | null;
  return parseFormIds(metafield?.value);
}

export async function addInitialCreatorTags(
  client: ShopifyGraphqlClient,
  customerId: string,
): Promise<void> {
  const result = await client.request<{
    tagsAdd: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation AddInitialCreatorTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    {
      id: normalizeCustomerGid(customerId),
      tags: ["creator-applicant", "creator-pending"],
    },
  );
  if (result.tagsAdd.userErrors.length)
    throw new Error("Initial creator tag synchronization failed.");
}

function mapMetafieldValues(
  map: HeliumMetafieldMap,
  metafields: CustomerMetafield[],
): HeliumCustomerInput["fields"] {
  const fields: HeliumCustomerInput["fields"] = {};
  for (const [field, identifier] of Object.entries(map) as Array<
    [HeliumField, { namespace: string; key: string }]
  >) {
    const metafield = metafields.find(
      (item) =>
        item.namespace === identifier.namespace && item.key === identifier.key,
    );
    fields![field] = field === "creatorProfilePhoto" ? (metafield?.reference?.image?.url || metafield?.reference?.url || metafield?.value) : metafield?.value;
  }
  return fields;
}

function sanitizedApplicationAnswers(value: string | undefined): string {
  if (!value) return "{}";
  try {
    return JSON.stringify(JSON.parse(value), (key, item) =>
      /email|phone|address|first.?name|last.?name/i.test(key)
        ? undefined
        : item,
    );
  } catch {
    // Unstructured answers cannot be reliably stripped of protected customer data.
    return "{}";
  }
}

function heliumApplicationData(input: HeliumCustomerInput) { return { legalName: input.fields?.legalName, displayName: input.fields?.creatorDisplayName, country: input.fields?.country, city: input.fields?.city, bio: input.fields?.shortCreatorBio, portfolioUrl: input.fields?.portfolioUrl, socialLinksJson: input.fields?.socialProfiles || "[]", profileImageUrl: input.fields?.creatorProfilePhoto, message: input.fields?.applicationMessage }; }

async function ensureHeliumApplication(shop: string, creatorId: string, status: string | null, input: HeliumCustomerInput) {
  const existing = await db.creatorApplication.findFirst({ where: { creatorId, source: "HELIUM_IMPORT" }, orderBy: { createdAt: "desc" } });
  const data = heliumApplicationData(input);
  if (existing) { await db.creatorApplication.update({ where: { id: existing.id }, data }); return "UPDATED" as const; }
  await db.creatorApplication.create({ data: { shop, creatorId, source: "HELIUM_IMPORT", answersJson: sanitizedApplicationAnswers(input.fields?.applicationMessage), status: status === "APPROVED" ? "APPROVED" : status === "REJECTED" ? "REJECTED" : "PENDING", ...data } });
  return "CREATED" as const;
}

export async function fetchHeliumCustomer(
  client: ShopifyGraphqlClient,
  customerId: string,
  map: HeliumMetafieldMap,
): Promise<HeliumCustomerInput | null> {
  const metafields = mappedMetafieldQuery(map);
  const result = await client.request<{
    customer: ({
      id: string;
      tags: string[];
    } & Record<string, unknown>) | null;
  }>(
    `#graphql query HeliumCustomer($id: ID!${metafields.variableDefinitions ? `, ${metafields.variableDefinitions}` : ""}) { customer(id: $id) { id tags creatorFormIds: metafield(namespace: "customer_fields", key: "form_ids") { value } ${metafields.selection} } }`,
    {
      id: normalizeCustomerGid(customerId),
      ...metafields.variables,
    },
  );
  return result.customer
    ? {
        customerId: result.customer.id,
        tags: result.customer.tags,
        formIds: customerFormIds(result.customer),
        fields: mapMetafieldValues(map, metafields.values(result.customer)),
      }
    : null;
}

async function uniqueHandle(
  shop: string,
  displayName: string,
): Promise<string> {
  const base = slugify(displayName);
  let handle = base;
  let suffix = 2;
  while (await db.creator.findFirst({ where: { shop, handle } }))
    handle = `${base}-${suffix++}`;
  return handle;
}

export async function findCreatorByCustomerIdentity(
  shop: string,
  customerId: string,
) {
  const gid = normalizeCustomerGid(customerId);
  return db.creator.findUnique({
    where: { shop_customerId: { shop, customerId: gid } },
  });
}

export async function applyHeliumSync(
  shop: string,
  input: HeliumCustomerInput,
  source: "WEBHOOK" | "IMPORT" | "LAZY",
  dryRun = false,
) {
  const customerId = normalizeCustomerGid(input.customerId);
  const existing = await findCreatorByCustomerIdentity(shop, customerId);
  const externalSnapshotHash = snapshotHash(input);
  const plan = planHeliumSync(existing, {
    ...input,
    customerId,
    snapshotHash: externalSnapshotHash,
  });
  if (dryRun) return plan;
  if (plan.action === "SKIP") {
    if (existing && (existing.externalSnapshotHash !== externalSnapshotHash || existing.externalSyncConflict !== (plan.result === "CONFLICT"))) await db.creator.update({ where: { id: existing.id }, data: { externalSnapshotHash, lastExternalSyncAt: new Date(), externalSyncConflict: plan.result === "CONFLICT" } });
    if (plan.result === "CONFLICT" && existing)
      await db.auditLog.create({
        data: {
          shop,
          actorType: source,
          action: "helium.status_conflict",
          entityType: "Creator",
          entityId: existing.id,
          beforeJson: safeJson({
            status: existing.status,
            authority: existing.statusAuthority,
          }),
          afterJson: safeJson({ externalStatus: plan.status }),
        },
      });
    if (existing && plan.status) await ensureHeliumApplication(shop, existing.id, plan.status, input);
    return plan;
  }
  if (plan.action === "CREATE") {
    const displayName = String(plan.data.displayName);
    const handle = await uniqueHandle(shop, displayName);
    await db.$transaction(async (tx) => {
      const created = await tx.creator.create({
        data: {
          shop,
          customerId,
          handle,
          displayName,
          applicationSource: "HELIUM_IMPORT",
          statusAuthority: "HELIUM_IMPORT",
          lastExternalSyncAt: new Date(),
          externalSnapshotHash,
          externalSyncConflict: plan.result === "CONFLICT",
          status: plan.status!,
          legalName: plan.data.legalName as string | null,
          country: plan.data.country as string | null,
          city: plan.data.city as string | null,
          socialLinksJson: String(plan.data.socialLinksJson || "[]"),
          bio: plan.data.bio as string | null,
          portfolioUrl: plan.data.portfolioUrl as string | null,
          profileImageUrl: plan.data.profileImageUrl as string | null,
          approvedAt: plan.status === "APPROVED" ? new Date() : null,
          rejectedAt: plan.status === "REJECTED" ? new Date() : null,
          suspendedAt: plan.status === "SUSPENDED" ? new Date() : null,
        },
      });
      await tx.creatorApplication.create({
        data: {
          shop,
          creatorId: created.id,
          source: "HELIUM_IMPORT",
          answersJson: sanitizedApplicationAnswers(
            input.fields?.applicationMessage,
          ),
          legalName: input.fields?.legalName,
          displayName: input.fields?.creatorDisplayName,
          country: input.fields?.country,
          city: input.fields?.city,
          bio: input.fields?.shortCreatorBio,
          portfolioUrl: input.fields?.portfolioUrl,
          socialLinksJson: input.fields?.socialProfiles || "[]",
          profileImageUrl: input.fields?.creatorProfilePhoto,
          message: input.fields?.applicationMessage,
          termsAcceptedAt: input.fields?.termsAccepted ? new Date() : null,
          status:
            plan.status === "APPROVED"
              ? "APPROVED"
              : plan.status === "REJECTED"
                ? "REJECTED"
                : "PENDING",
          reviewedAt:
            plan.status === "APPROVED" || plan.status === "REJECTED"
              ? new Date()
              : null,
        },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: source,
          action: "helium.creator.created",
          entityType: "Creator",
          entityId: created.id,
          afterJson: safeJson({ status: created.status, source }),
        },
      });
      return created;
    });
    return plan;
  }
  const statusDates = plan.data.status
    ? {
        approvedAt:
          plan.data.status === "APPROVED" ? new Date() : existing!.approvedAt,
        rejectedAt: plan.data.status === "REJECTED" ? new Date() : null,
        suspendedAt: plan.data.status === "SUSPENDED" ? new Date() : null,
      }
    : {};
  const creator = await db.creator.update({
    where: { id: existing!.id },
    data: {
      ...plan.data,
      ...statusDates,
      lastExternalSyncAt: new Date(),
      externalSnapshotHash,
      externalSyncConflict: plan.result === "CONFLICT",
    },
  });
  await ensureHeliumApplication(shop, creator.id, plan.status, input);
  await db.auditLog.create({
    data: {
      shop,
      actorType: source,
      action: "helium.creator.updated",
      entityType: "Creator",
      entityId: creator.id,
      beforeJson: safeJson({ status: existing!.status }),
      afterJson: safeJson({ status: creator.status, source }),
    },
  });
  return plan;
}

export async function lazySyncCreator(
  shop: string,
  customerId: string,
  client: ShopifyGraphqlClient,
): Promise<boolean> {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { heliumMetafieldMapJson: true, heliumCreatorFormId: true },
  });
  const customer = await fetchHeliumCustomer(
    client,
    customerId,
    parseHeliumMetafieldMap(config?.heliumMetafieldMapJson),
  );
  if (!customer) return false;
  const input = withHeliumCreatorFormTags(
    customer,
    config?.heliumCreatorFormId,
  );
  if (!creatorStatusFromTags(input.tags)) return false;
  if (!creatorStatusFromTags(customer.tags))
    await addInitialCreatorTags(client, customer.customerId);
  await applyHeliumSync(shop, input, "LAZY");
  return true;
}

export async function syncExistingCreators(
  shop: string,
  client: ShopifyGraphqlClient,
  dryRun: boolean,
) {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { heliumMetafieldMapJson: true, heliumCreatorFormId: true },
  });
  const map = parseHeliumMetafieldMap(config?.heliumMetafieldMapJson);
  const metafields = mappedMetafieldQuery(map);
  let cursor: string | null = null;
  const counts = { create: 0, update: 0, skip: 0, conflict: 0, applicationCreate: 0, applicationUpdate: 0, invalidImageReference: 0 };
  const preview: Array<{
    customerId: string;
    action: string;
    status: string | null;
    conflict: boolean;
    reason: string;
  }> = [];
  let customersWithoutUsableId = 0;
  do {
    const result: {
      customers: {
        nodes: Array<
          {
          id: string;
          tags: string[];
          } & Record<string, unknown>
        >;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      `#graphql query HeliumCreators($after: String${metafields.variableDefinitions ? `, ${metafields.variableDefinitions}` : ""}) { customers(first: 100, after: $after) { nodes { id tags creatorFormIds: metafield(namespace: "customer_fields", key: "form_ids") { value } ${metafields.selection} } pageInfo { hasNextPage endCursor } } }`,
      { after: cursor, ...metafields.variables },
    );
    for (const customer of result.customers.nodes) {
      if (!customer.id.startsWith("gid://shopify/Customer/")) {
        customersWithoutUsableId++;
        continue;
      }
      const originalStatus = creatorStatusFromTags(customer.tags);
      const input = withHeliumCreatorFormTags(
        {
          customerId: customer.id,
          tags: customer.tags,
          formIds: customerFormIds(customer),
          fields: mapMetafieldValues(map, metafields.values(customer)),
        },
        config?.heliumCreatorFormId,
      );
      if (!creatorStatusFromTags(input.tags)) continue;
      const conflict = hasConflictingCreatorTags(input.tags);
      if (conflict) counts.conflict++;
      const existingCreator = await findCreatorByCustomerIdentity(shop, customer.id);
      const existingApplication = existingCreator ? await db.creatorApplication.findFirst({ where: { creatorId: existingCreator.id, source: "HELIUM_IMPORT" }, select: { id: true } }) : null;
      if (existingApplication) counts.applicationUpdate++; else counts.applicationCreate++;
      const mappedFields = input.fields;
      if (mappedFields?.creatorProfilePhoto?.startsWith("gid://")) counts.invalidImageReference++;
      if (!dryRun && !originalStatus)
        await addInitialCreatorTags(client, customer.id);
      const plan = await applyHeliumSync(
        shop,
        {
          customerId: customer.id,
          tags: input.tags,
          formIds: input.formIds,
          fields: mappedFields,
        },
        "IMPORT",
        dryRun,
      );
      counts[plan.action.toLowerCase() as "create" | "update" | "skip"]++;
      if (plan.result === "CONFLICT" && !conflict) counts.conflict++;
      if (preview.length < 100)
        preview.push({
          customerId: customer.id,
          action: plan.action,
          status: plan.status,
          conflict,
          reason: plan.reason,
        });
    }
    cursor = result.customers.pageInfo.hasNextPage
      ? result.customers.pageInfo.endCursor
      : null;
  } while (cursor);
  const missingMappings = (
    [
      "legalName",
      "creatorDisplayName",
      "country",
      "city",
      "creatorProfilePhoto",
      "shortCreatorBio",
      "portfolioUrl",
      "socialProfiles",
      "termsAccepted",
      "applicationMessage",
    ] as HeliumField[]
  ).filter((field) => !map[field]);
  if (!dryRun)
    await db.shopConfig.update({
      where: { shop },
      data: { heliumMigrationCompletedAt: new Date() },
    });
  return {
    ...counts,
    applicantsFound: counts.create + counts.update + counts.skip,
    customersWithoutUsableId,
    missingMappings,
    preview,
  };
}
