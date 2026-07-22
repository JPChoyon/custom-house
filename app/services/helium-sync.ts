import type { Creator, CreatorStatus } from "@prisma/client";
import { CREATOR_TAGS } from "./domain.ts";

export interface HeliumCustomerInput {
  customerId: string;
  tags: string[];
  fields?: Partial<Record<"displayName" | "biography" | "portfolioUrl" | "profileImage" | "applicationAnswers", string>>;
}
export type HeliumField = "displayName" | "biography" | "portfolioUrl" | "profileImage" | "applicationAnswers";
export type HeliumMetafieldMap = Partial<Record<HeliumField, { namespace: string; key: string }>>;

export function parseHeliumMetafieldMap(value: string | null | undefined): HeliumMetafieldMap {
  try {
    const parsed = JSON.parse(value || "{}") as Record<string, unknown>; const result: HeliumMetafieldMap = {};
    for (const field of ["displayName", "biography", "portfolioUrl", "profileImage", "applicationAnswers"] as HeliumField[]) {
      const entry = parsed[field];
      if (entry && typeof entry === "object") { const { namespace, key } = entry as { namespace?: unknown; key?: unknown }; if (typeof namespace === "string" && namespace && typeof key === "string" && key) result[field] = { namespace, key }; }
    }
    return result;
  } catch { return {}; }
}

export function serializeHeliumMetafieldMap(form: FormData): string {
  const result: HeliumMetafieldMap = {};
  for (const field of ["displayName", "biography", "portfolioUrl", "profileImage", "applicationAnswers"] as HeliumField[]) {
    const value = String(form.get(`helium.${field}`) || "").trim(); if (!value) continue; const separator = value.indexOf(".");
    if (separator < 1 || separator === value.length - 1) throw new Error(`Helium ${field} mapping must use namespace.key.`);
    result[field] = { namespace: value.slice(0, separator), key: value.slice(separator + 1) };
  }
  return JSON.stringify(result);
}

export function formatHeliumMappingEntry(map: HeliumMetafieldMap, field: HeliumField): string { const entry = map[field]; return entry ? `${entry.namespace}.${entry.key}` : ""; }
export type HeliumSyncAction = "CREATE" | "UPDATE" | "SKIP";
export interface HeliumSyncPlan { action: HeliumSyncAction; status: CreatorStatus | null; data: Record<string, unknown>; reason: string }

export function normalizeCustomerGid(value: string | number): string {
  const id = String(value).trim();
  return id.startsWith("gid://shopify/Customer/") ? id : `gid://shopify/Customer/${id}`;
}

export function creatorStatusFromTags(tags: string[]): CreatorStatus | null {
  const values = new Set(tags.map((tag) => tag.toLowerCase()));
  if (values.has(CREATOR_TAGS.SUSPENDED)) return "SUSPENDED";
  if (values.has(CREATOR_TAGS.REJECTED)) return "REJECTED";
  if (values.has(CREATOR_TAGS.APPROVED)) return "APPROVED";
  if (values.has(CREATOR_TAGS.PENDING) || values.has(CREATOR_TAGS.applicant)) return "PENDING";
  return null;
}

export function hasConflictingCreatorTags(tags: string[]): boolean {
  const statusTags = new Set([CREATOR_TAGS.PENDING, CREATOR_TAGS.APPROVED, CREATOR_TAGS.REJECTED, CREATOR_TAGS.SUSPENDED]);
  return new Set(tags.map((tag) => tag.toLowerCase()).filter((tag) => statusTags.has(tag as typeof CREATOR_TAGS.PENDING))).size > 1;
}

export function planHeliumSync(existing: Creator | null, input: HeliumCustomerInput): HeliumSyncPlan {
  const status = creatorStatusFromTags(input.tags);
  if (!status) return { action: "SKIP", status: null, data: {}, reason: "No creator tag" };
  const fields = input.fields || {};
  if (!existing) return { action: "CREATE", status, reason: "Creator tag found", data: { status, displayName: fields.displayName?.trim() || `Creator ${normalizeCustomerGid(input.customerId).split("/").at(-1)}`, bio: fields.biography?.trim() || null, portfolioUrl: fields.portfolioUrl?.trim() || null, profileImageUrl: fields.profileImage?.trim() || null } };
  const data: Record<string, unknown> = {};
  const managed = Boolean(existing.approvedAt || existing.rejectedAt || existing.suspendedAt);
  if (!managed && existing.status !== status) data.status = status;
  if (!existing.bio && fields.biography?.trim()) data.bio = fields.biography.trim();
  if (!existing.portfolioUrl && fields.portfolioUrl?.trim()) data.portfolioUrl = fields.portfolioUrl.trim();
  if (!existing.profileImageUrl && fields.profileImage?.trim()) data.profileImageUrl = fields.profileImage.trim();
  if (existing.displayName.startsWith("Creator ") && fields.displayName?.trim()) data.displayName = fields.displayName.trim();
  return Object.keys(data).length ? { action: "UPDATE", status, data, reason: "Filled unmapped fields or synchronized an undecided status" } : { action: "SKIP", status, data: {}, reason: managed ? "App-managed decision preserved" : "Already synchronized" };
}

export async function loadWithLazySync<T extends { creatorFound: boolean }>(load: () => Promise<T>, synchronize: () => Promise<unknown>): Promise<T> {
  let result = await load();
  if (!result.creatorFound) { await synchronize(); result = await load(); }
  return result;
}
