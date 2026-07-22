import db from "../db.server";
import { safeJson, slugify } from "./domain";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import {
  creatorStatusFromTags,
  hasConflictingCreatorTags,
  normalizeCustomerGid,
  parseHeliumMetafieldMap,
  planHeliumSync,
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

function mappedIdentifiers(map: HeliumMetafieldMap) {
  return Object.values(map).map(({ namespace, key }) => ({ namespace, key }));
}

function mapMetafieldValues(
  map: HeliumMetafieldMap,
  metafields: Array<{ namespace: string; key: string; value: string }>,
): HeliumCustomerInput["fields"] {
  const fields: HeliumCustomerInput["fields"] = {};
  for (const [field, identifier] of Object.entries(map) as Array<
    [HeliumField, { namespace: string; key: string }]
  >) {
    fields![field] = metafields.find(
      (item) =>
        item.namespace === identifier.namespace && item.key === identifier.key,
    )?.value;
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

export async function fetchHeliumCustomer(
  client: ShopifyGraphqlClient,
  customerId: string,
  map: HeliumMetafieldMap,
): Promise<HeliumCustomerInput | null> {
  const result = await client.request<{
    customer: {
      id: string;
      tags: string[];
      metafields: Array<{ namespace: string; key: string; value: string }>;
    } | null;
  }>(
    `#graphql query HeliumCustomer($id: ID!, $identifiers: [HasMetafieldsIdentifier!]!) { customer(id: $id) { id tags metafields(identifiers: $identifiers) { namespace key value } } }`,
    {
      id: normalizeCustomerGid(customerId),
      identifiers: mappedIdentifiers(map),
    },
  );
  return result.customer
    ? {
        customerId: result.customer.id,
        tags: result.customer.tags,
        fields: mapMetafieldValues(map, result.customer.metafields),
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
  const plan = planHeliumSync(existing, { ...input, customerId });
  if (dryRun || plan.action === "SKIP") return plan;
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
          status: plan.status!,
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
            input.fields?.applicationAnswers,
          ),
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
    data: { ...plan.data, ...statusDates },
  });
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
    select: { heliumMetafieldMapJson: true },
  });
  const customer = await fetchHeliumCustomer(
    client,
    customerId,
    parseHeliumMetafieldMap(config?.heliumMetafieldMapJson),
  );
  if (!customer || !creatorStatusFromTags(customer.tags)) return false;
  await applyHeliumSync(shop, customer, "LAZY");
  return true;
}

export async function syncExistingCreators(
  shop: string,
  client: ShopifyGraphqlClient,
  dryRun: boolean,
) {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { heliumMetafieldMapJson: true },
  });
  const map = parseHeliumMetafieldMap(config?.heliumMetafieldMapJson);
  let cursor: string | null = null;
  const counts = { create: 0, update: 0, skip: 0, conflict: 0 };
  const preview: Array<{ customerId: string; action: string; status: string | null; conflict: boolean; reason: string }> = [];
  let customersWithoutUsableId = 0;
  do {
    const result: {
      customers: {
        nodes: Array<{
          id: string;
          tags: string[];
          metafields: Array<{ namespace: string; key: string; value: string }>;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      `#graphql query HeliumCreators($after: String, $identifiers: [HasMetafieldsIdentifier!]!) { customers(first: 100, after: $after, query: "tag:creator-applicant OR tag:creator-pending OR tag:creator-approved OR tag:creator-rejected OR tag:creator-suspended") { nodes { id tags metafields(identifiers: $identifiers) { namespace key value } } pageInfo { hasNextPage endCursor } } }`,
      { after: cursor, identifiers: mappedIdentifiers(map) },
    );
    for (const customer of result.customers.nodes) {
      if (!customer.id.startsWith("gid://shopify/Customer/")) { customersWithoutUsableId++; continue; }
      const conflict = hasConflictingCreatorTags(customer.tags);
      if (conflict) counts.conflict++;
      const plan = await applyHeliumSync(
        shop,
        {
          customerId: customer.id,
          tags: customer.tags,
          fields: mapMetafieldValues(map, customer.metafields),
        },
        "IMPORT",
        dryRun,
      );
      counts[plan.action.toLowerCase() as "create" | "update" | "skip"]++;
      if (preview.length < 100) preview.push({ customerId: customer.id, action: plan.action, status: plan.status, conflict, reason: plan.reason });
    }
    cursor = result.customers.pageInfo.hasNextPage
      ? result.customers.pageInfo.endCursor
      : null;
  } while (cursor);
  const missingMappings = (["displayName", "biography", "portfolioUrl", "profileImage", "applicationAnswers"] as HeliumField[]).filter((field) => !map[field]);
  if (!dryRun) await db.shopConfig.update({ where: { shop }, data: { heliumMigrationCompletedAt: new Date() } });
  return { ...counts, applicantsFound: counts.create + counts.update + counts.skip, customersWithoutUsableId, missingMappings, preview };
}
