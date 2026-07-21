import type { CreatorStatus } from "@prisma/client";
import db from "../db.server";
import { CREATOR_TAGS, DomainError, safeJson, slugify, statusTags } from "./domain";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";

export interface ApplicationInput { displayName: string; bio: string; portfolioUrl?: string; profileImageUrl?: string; confirmed: boolean }
export async function createApplication(shop: string, customerId: string, input: ApplicationInput) {
  if (!input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", "Confirm the creator terms.");
  const displayName = input.displayName.trim(); if (displayName.length < 2 || displayName.length > 80) throw new DomainError("INVALID_NAME", "Display name must be 2–80 characters.");
  if (input.bio.trim().length < 10 || input.bio.length > 1000) throw new DomainError("INVALID_BIO", "Biography must be 10–1000 characters.");
  for (const value of [input.portfolioUrl, input.profileImageUrl].filter(Boolean)) { const url = new URL(value!); if (url.protocol !== "https:") throw new DomainError("INVALID_URL", "Profile URLs must use HTTPS."); }
  if (await db.creatorApplication.findFirst({ where: { shop, creator: { customerId }, status: "PENDING" } })) throw new DomainError("DUPLICATE_APPLICATION", "A pending application already exists.", 409);
  let handle = slugify(displayName), suffix = 2; while (await db.creator.findFirst({ where: { shop, handle, NOT: { customerId } } })) handle = `${slugify(displayName)}-${suffix++}`;
  return db.$transaction(async (tx) => {
    const creator = await tx.creator.upsert({ where: { shop_customerId: { shop, customerId } }, update: { displayName, handle, bio: input.bio.trim(), portfolioUrl: input.portfolioUrl, profileImageUrl: input.profileImageUrl, status: "PENDING", rejectionReason: null }, create: { shop, customerId, displayName, handle, bio: input.bio.trim(), portfolioUrl: input.portfolioUrl, profileImageUrl: input.profileImageUrl } });
    const application = await tx.creatorApplication.create({ data: { shop, creatorId: creator.id, answersJson: safeJson(input) } });
    await tx.auditLog.create({ data: { shop, actorType: "CUSTOMER", actorId: customerId, action: "application.created", entityType: "CreatorApplication", entityId: application.id } }); return { creator, application };
  });
}

export async function changeCreatorStatus(shop: string, creatorId: string, next: CreatorStatus, client: ShopifyGraphqlClient, reason?: string) {
  const creator = await db.creator.findFirst({ where: { id: creatorId, shop } }); if (!creator) throw new DomainError("NOT_FOUND", "Creator not found.", 404);
  const customer = await client.request<{ customer: { id: string; tags: string[] } | null }>(`#graphql query($id: ID!) { customer(id: $id) { id tags } }`, { id: creator.customerId });
  if (!customer.customer) throw new DomainError("CUSTOMER_NOT_FOUND", "The Shopify customer no longer exists.", 409);
  const result = await client.request<{ customerUpdate: { userErrors: Array<{ message: string }> } }>(`#graphql mutation($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { message } } }`, { input: { id: creator.customerId, tags: statusTags(customer.customer.tags, next) } }); throwUserErrors(result.customerUpdate.userErrors, "Customer tag sync");
  const now = new Date(); return db.$transaction(async (tx) => {
    const updated = await tx.creator.update({ where: { id: creator.id }, data: { status: next, approvedAt: next === "APPROVED" ? now : creator.approvedAt, rejectedAt: next === "REJECTED" ? now : null, suspendedAt: next === "SUSPENDED" ? now : null, rejectionReason: next === "REJECTED" ? reason : null, suspensionReason: next === "SUSPENDED" ? reason : null } });
    if (next === "APPROVED" || next === "REJECTED") await tx.creatorApplication.updateMany({ where: { creatorId, status: "PENDING" }, data: { status: next, reviewerNote: reason, reviewedAt: now } });
    await tx.auditLog.create({ data: { shop, actorType: "ADMIN", action: `creator.${next.toLowerCase()}`, entityType: "Creator", entityId: creatorId, beforeJson: safeJson({ status: creator.status }), afterJson: safeJson({ status: next, reason }) } }); return updated;
  });
}

export const defaultCreatorTags = Object.values(CREATOR_TAGS);
